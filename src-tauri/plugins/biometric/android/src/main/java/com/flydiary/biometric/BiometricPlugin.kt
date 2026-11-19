// Copyright 2026 Fly Diary contributors
// SPDX-License-Identifier: MIT

package com.flydiary.biometric

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val KEYSTORE = "AndroidKeyStore"
private const val TRANSFORMATION = "AES/GCM/NoPadding"
private const val GCM_TAG_BITS = 128

@InvokeArg
class StatusArgs {
  var alias: String? = null
}

@InvokeArg
class EnrollArgs {
  lateinit var alias: String
  lateinit var payload: String
  lateinit var aad: String
}

@InvokeArg
class DecryptArgs {
  lateinit var alias: String
  lateinit var iv: String
  lateinit var ciphertext: String
  lateinit var aad: String
}

@InvokeArg
class DeleteArgs {
  lateinit var alias: String
}

/**
 * Android side of the biometric plugin.
 *
 * The diary key is encrypted by an AES key that only becomes usable after a
 * successful `BiometricPrompt` with a `CryptoObject`. The key itself never
 * leaves the Android Keystore.
 */
@TauriPlugin
class BiometricPlugin(private val activity: Activity) : Plugin(activity) {
  private val keyStore: KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  /** Keep the prompt alive while it is showing; a local reference can be collected. */
  private var activePrompt: BiometricPrompt? = null

  @Command
  fun status(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(StatusArgs::class.java)
      val keyguard =
        activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      val secure = keyguard.isDeviceSecure
      val manager = BiometricManager.from(activity)
      val canAuthenticate =
        manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      val alias = args.alias
      val keyExists = alias != null && keyStore.containsAlias(alias)

      val result = JSObject()
      result.put("available", secure && canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS)
      result.put("keyExists", keyExists)

      val reason =
        when {
          !secure -> "no_device_credential"
          canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS -> null
          canAuthenticate == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no_hardware"
          canAuthenticate == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "unavailable"
          canAuthenticate == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "not_enrolled"
          canAuthenticate == BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED ->
            "security_update"
          else -> "unknown"
        }
      if (reason != null) result.put("reason", reason)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(message(error))
    }
  }

  @Command
  fun enroll(invoke: Invoke) {
    val args = invoke.parseArgs(EnrollArgs::class.java)
    activity.runOnUiThread {
      try {
        val key = createKey(args.alias)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val iv = cipher.iv ?: throw IllegalStateException("The cipher did not produce an IV")

        authenticate(invoke, cipher, args.aad.toByteArray(Charsets.UTF_8)) { unlocked ->
          val ciphertext =
            unlocked.doFinal(Base64.decode(args.payload, Base64.NO_WRAP))
          val result = JSObject()
          result.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
          result.put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
          invoke.resolve(result)
        }
      } catch (error: Exception) {
        invoke.reject(message(error))
      }
    }
  }

  @Command
  fun decrypt(invoke: Invoke) {
    val args = invoke.parseArgs(DecryptArgs::class.java)
    activity.runOnUiThread {
      try {
        val key =
          keyStore.getKey(args.alias, null) as? SecretKey
            ?: throw IllegalStateException("The biometric key is missing")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
          Cipher.DECRYPT_MODE,
          key,
          GCMParameterSpec(GCM_TAG_BITS, Base64.decode(args.iv, Base64.NO_WRAP)),
        )

        authenticate(invoke, cipher, args.aad.toByteArray(Charsets.UTF_8)) { unlocked ->
          val plaintext =
            unlocked.doFinal(Base64.decode(args.ciphertext, Base64.NO_WRAP))
          val result = JSObject()
          result.put("payload", Base64.encodeToString(plaintext, Base64.NO_WRAP))
          invoke.resolve(result)
        }
      } catch (error: Exception) {
        invoke.reject(message(error))
      }
    }
  }

  @Command
  fun deleteKey(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(DeleteArgs::class.java)
      keyStore.deleteEntry(args.alias)
      invoke.resolve(JSObject())
    } catch (error: Exception) {
      invoke.reject(message(error))
    }
  }

  /** Create a per-use, biometric-bound AES-GCM key. */
  @Suppress("DEPRECATION")
  private fun createKey(alias: String): SecretKey {
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    val builder =
      KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setUserAuthenticationRequired(true)
        .setInvalidatedByBiometricEnrollment(true)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(
        0,
        KeyProperties.AUTH_BIOMETRIC_STRONG,
      )
    } else {
      builder.setUserAuthenticationValidityDurationSeconds(-1)
    }

    generator.init(builder.build())
    return generator.generateKey()
  }

  /** Run BiometricPrompt and hand the authenticated cipher back to the caller. */
  private fun authenticate(
    invoke: Invoke,
    cipher: Cipher,
    aad: ByteArray,
    onSuccess: (Cipher) -> Unit,
  ) {
    val prompt =
      BiometricPrompt(
        activity as FragmentActivity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(
            result: BiometricPrompt.AuthenticationResult,
          ) {
            activePrompt = null
            try {
              val unlocked = result.cryptoObject?.cipher ?: cipher
              // AAD must be set after authentication: on Keystore2 an
              // auth-per-use key rejects updateAAD before the auth token
              // exists ("Key user not authenticated").
              unlocked.updateAAD(aad)
              onSuccess(unlocked)
            } catch (error: Exception) {
              invoke.reject(message(error))
            }
          }

          override fun onAuthenticationError(
            errorCode: Int,
            errString: CharSequence,
          ) {
            activePrompt = null
            val reason = errString.toString()
            when (errorCode) {
              BiometricPrompt.ERROR_USER_CANCELED,
              BiometricPrompt.ERROR_NEGATIVE_BUTTON,
              BiometricPrompt.ERROR_CANCELED ->
                invoke.reject("BIOMETRIC_CANCELED: $reason")
              BiometricPrompt.ERROR_LOCKOUT ->
                invoke.reject("BIOMETRIC_LOCKOUT: $reason")
              BiometricPrompt.ERROR_LOCKOUT_PERMANENT ->
                invoke.reject("BIOMETRIC_LOCKOUT_PERMANENT: $reason")
              BiometricPrompt.ERROR_NO_BIOMETRICS ->
                invoke.reject("BIOMETRIC_NOT_ENROLLED: $reason")
              BiometricPrompt.ERROR_HW_NOT_PRESENT ->
                invoke.reject("BIOMETRIC_NO_HARDWARE: $reason")
              BiometricPrompt.ERROR_HW_UNAVAILABLE ->
                invoke.reject("BIOMETRIC_UNAVAILABLE: $reason")
              BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED ->
                invoke.reject("BIOMETRIC_SECURITY_UPDATE: $reason")
              else -> invoke.reject("BIOMETRIC_FAILED($errorCode): $reason")
            }
          }

          override fun onAuthenticationFailed() {
            // The system keeps the prompt open for another attempt.
          }
        },
      )
    activePrompt = prompt

    val info =
      BiometricPrompt.PromptInfo.Builder()
        .setTitle("生物辨識解鎖")
        .setSubtitle("解鎖 Fly Diary")
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .setNegativeButtonText(activity.getString(android.R.string.cancel))
        .build()

    try {
      prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    } catch (error: Exception) {
      activePrompt = null
      invoke.reject(message(error))
    }
  }

  private fun message(error: Exception): String {
    val detail = error.message ?: "Biometric authentication failed"
    return when (error) {
      is KeyPermanentlyInvalidatedException -> "BIOMETRIC_KEY_INVALIDATED: $detail"
      is UnrecoverableKeyException -> "BIOMETRIC_KEY_INVALIDATED: $detail"
      else -> "BIOMETRIC_FAILED: ${error.javaClass.simpleName}: $detail"
    }
  }
}

package com.flydiary.safsync

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.Executors

@InvokeArg
class UriArgs {
    var uri: String? = null
}

@InvokeArg
class CopyToLocalArgs {
    var uri: String? = null
    var remotePath: String? = null
    var localPath: String? = null
    var maxBytes: Long = 0
}

@InvokeArg
class CopyFromLocalArgs {
    var uri: String? = null
    var localPath: String? = null
    var remotePath: String? = null
}

@InvokeArg
class DeleteArgs {
    var uri: String? = null
    var remotePath: String? = null
}

/**
 * Storage Access Framework bridge.
 *
 * The app never turns the tree URI into a filesystem path: Android only grants
 * access through `ContentResolver`, and scoped storage would reject a raw
 * `/storage/...` path anyway. Bulk bytes are streamed directly between the SAF
 * document and an app-private file, so they never cross the JavaScript bridge.
 */
@TauriPlugin
class SafSyncPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        private const val MAX_LISTED_FILES = 50_000
        private const val MAX_DEPTH = 4
        private const val BUFFER_SIZE = 64 * 1024
    }

    private fun tree(uri: String): DocumentFile =
        DocumentFile.fromTreeUri(activity, Uri.parse(uri))
            ?: throw IOException("Cannot open the selected folder")

    /**
     * Tauri dispatches plugin commands on the Android main thread. File I/O
     * must not block the UI, so every resolver/stream operation runs on one
     * dedicated worker (one at a time, which also keeps SAF access serial).
     */
    private val io = Executors.newSingleThreadExecutor()

    private fun runOnIo(invoke: Invoke, failure: String, block: () -> Unit) {
        io.execute {
            try {
                block()
            } catch (error: Exception) {
                invoke.reject(error.message ?: failure)
            }
        }
    }

    private fun permissionFlags(): Int =
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

    private fun hasWritePermission(uri: Uri): Boolean =
        activity.contentResolver.persistedUriPermissions.any {
            it.uri == uri && it.isWritePermission
        }

    @Command
    fun pickDirectory(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                        Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
                )
            }
            startActivityForResult(invoke, intent, "pickDirectoryResult")
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Cannot open the folder picker")
        }
    }

    @ActivityCallback
    fun pickDirectoryResult(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            // Cancelling is a normal outcome, not an error.
            invoke.resolve(JSObject())
            return
        }
        try {
            activity.contentResolver.takePersistableUriPermission(uri, permissionFlags())
        } catch (error: SecurityException) {
            invoke.reject("The folder does not grant write access")
            return
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Cannot keep access to the folder")
            return
        }

        val document = DocumentFile.fromTreeUri(activity, uri)
        val response = JSObject()
        response.put("uri", uri.toString())
        response.put("name", document?.name ?: uri.lastPathSegment ?: "Folder")
        invoke.resolve(response)
    }

    @Command
    fun checkDirectory(invoke: Invoke) = runOnIo(invoke, "Cannot check the folder") {
        val args = invoke.parseArgs(UriArgs::class.java)
        val uri = Uri.parse(args.uri ?: throw IllegalArgumentException("Missing URI"))
        val document = DocumentFile.fromTreeUri(activity, uri)
        val available = hasWritePermission(uri) &&
            document != null &&
            document.exists() &&
            document.isDirectory
        val response = JSObject()
        response.put("available", available)
        response.put("name", document?.name ?: uri.lastPathSegment ?: "Folder")
        invoke.resolve(response)
    }

    @Command
    fun listFiles(invoke: Invoke) = runOnIo(invoke, "Cannot list the folder") {
        val args = invoke.parseArgs(UriArgs::class.java)
        val uri = Uri.parse(args.uri ?: throw IllegalArgumentException("Missing URI"))
        val root = tree(uri.toString())
        if (!hasWritePermission(uri)) {
            throw SecurityException("Access to the folder was revoked")
        }
        val files = JSArray()
        val counter = intArrayOf(0)
        listRecursive(root, "", files, counter, 0)
        val response = JSObject()
        response.put("files", files)
        invoke.resolve(response)
    }

    private fun listRecursive(
        directory: DocumentFile,
        prefix: String,
        files: JSArray,
        counter: IntArray,
        depth: Int
    ) {
        if (depth > MAX_DEPTH) return
        for (document in directory.listFiles()) {
            val name = document.name ?: continue
            if (document.isDirectory) {
                listRecursive(document, "$prefix$name/", files, counter, depth + 1)
                continue
            }
            // `.flydiary-*` is our own upload scratch file; never sync it.
            if (name.startsWith(".")) continue
            counter[0] += 1
            if (counter[0] > MAX_LISTED_FILES) {
                throw IOException("The folder contains too many files")
            }
            val entry = JSObject()
            entry.put("path", prefix + name)
            entry.put("size", document.length())
            entry.put("mtimeMs", document.lastModified())
            files.put(entry)
        }
    }

    @Command
    fun copyToLocal(invoke: Invoke) = runOnIo(invoke, "Cannot download the file") {
        val args = invoke.parseArgs(CopyToLocalArgs::class.java)
        val uri = Uri.parse(args.uri ?: throw IllegalArgumentException("Missing URI"))
        if (!hasWritePermission(uri)) {
            throw SecurityException("Access to the folder was revoked")
        }
        val root = tree(uri.toString())
        val document = find(root, args.remotePath ?: throw IllegalArgumentException("Missing path"))
            ?: throw IOException("File not found in the folder")
        if (document.isDirectory) throw IOException("Expected a file, found a folder")

        val declared = document.length()
        if (args.maxBytes > 0 && declared > args.maxBytes) {
            throw IOException("File is too large to sync")
        }

        val target = File(args.localPath ?: throw IllegalArgumentException("Missing local path"))
        val parent = target.parentFile ?: throw IOException("Invalid local path")
        if (!parent.exists() && !parent.mkdirs()) {
            throw IOException("Cannot create the local folder")
        }

        val temp = File.createTempFile(".flydiary-", ".tmp", parent)
        try {
            val input = activity.contentResolver.openInputStream(document.uri)
                ?: throw IOException("Cannot read the file")
            var written = 0L
            input.use { stream ->
                FileOutputStream(temp).use { output ->
                    val buffer = ByteArray(BUFFER_SIZE)
                    while (true) {
                        val read = stream.read(buffer)
                        if (read < 0) break
                        written += read
                        if (args.maxBytes > 0 && written > args.maxBytes) {
                            throw IOException("File is too large to sync")
                        }
                        output.write(buffer, 0, read)
                    }
                    output.flush()
                    // Pulls are atomic on the app-private side: a crash
                    // leaves the previous file or no file, never a half.
                    output.fd.sync()
                }
            }
            if (!temp.renameTo(target)) {
                throw IOException("Cannot replace the local file")
            }
            val response = JSObject()
            response.put("bytes", written)
            invoke.resolve(response)
        } finally {
            temp.delete()
        }
    }

    @Command
    fun copyFromLocal(invoke: Invoke) = runOnIo(invoke, "Cannot upload the file") {
        val args = invoke.parseArgs(CopyFromLocalArgs::class.java)
        val uri = Uri.parse(args.uri ?: throw IllegalArgumentException("Missing URI"))
        if (!hasWritePermission(uri)) {
            throw SecurityException("Access to the folder was revoked")
        }
        val local = File(args.localPath ?: throw IllegalArgumentException("Missing local path"))
        if (!local.isFile) throw IOException("Local file not found")

        val segments = (args.remotePath ?: throw IllegalArgumentException("Missing path"))
            .split('/')
            .filter { it.isNotEmpty() }
        if (segments.isEmpty() || segments.any { it == "." || it == ".." }) {
            throw IllegalArgumentException("Invalid path")
        }

        val root = tree(uri.toString())
        var parent = root
        for (segment in segments.dropLast(1)) {
            parent = parent.findFile(segment)
                ?: parent.createDirectory(segment)
                ?: throw IOException("Cannot create $segment")
        }

        val leaf = segments.last()
        val existing = parent.findFile(leaf)
        if (existing != null && existing.isDirectory) {
            throw IOException("A folder already uses the name $leaf")
        }

        val temp = parent.createFile("application/octet-stream", ".flydiary-${System.nanoTime()}")
            ?: throw IOException("Cannot create a temporary file")

        try {
            copyInto(local, temp.uri)
            existing?.delete()
            try {
                DocumentsContract.renameDocument(
                    activity.contentResolver,
                    temp.uri,
                    leaf
                )
            } catch (renameError: Exception) {
                // Some providers (notably cloud drives) do not implement
                // rename. Fall back to a direct write; the window is small
                // and a partial file is detected as a changed hash on the
                // next run instead of being trusted.
                temp.delete()
                val direct = parent.createFile("application/octet-stream", leaf)
                    ?: throw IOException("Cannot create $leaf")
                try {
                    copyInto(local, direct.uri)
                } catch (writeError: Exception) {
                    direct.delete()
                    throw writeError
                }
            }
        } catch (error: Exception) {
            temp.delete()
            throw error
        }

        val result = parent.findFile(leaf)
        val response = JSObject()
        response.put("size", result?.length() ?: local.length())
        response.put("mtimeMs", result?.lastModified() ?: 0L)
        invoke.resolve(response)
    }

    @Command
    fun deleteFile(invoke: Invoke) = runOnIo(invoke, "Cannot delete the file") {
        val args = invoke.parseArgs(DeleteArgs::class.java)
        val uri = Uri.parse(args.uri ?: throw IllegalArgumentException("Missing URI"))
        if (!hasWritePermission(uri)) {
            throw SecurityException("Access to the folder was revoked")
        }
        val root = tree(uri.toString())
        val document = find(root, args.remotePath ?: throw IllegalArgumentException("Missing path"))
        // Deleting a file that is already gone is success: that is the
        // state the caller asked for.
        if (document == null || !document.exists()) {
            invoke.resolve(JSObject())
            return@runOnIo
        }
        if (document.isDirectory) throw IOException("Expected a file, found a folder")
        if (!document.delete()) throw IOException("The folder refused the delete")
        invoke.resolve(JSObject())
    }

    private fun find(root: DocumentFile, path: String): DocumentFile? {
        var current: DocumentFile? = root
        for (segment in path.split('/')) {
            if (segment.isEmpty() || segment == "." || segment == "..") return null
            current = current?.findFile(segment) ?: return null
        }
        return current
    }

    private fun copyInto(local: File, destination: Uri) {
        val output = activity.contentResolver.openOutputStream(destination, "wt")
            ?: throw IOException("Cannot write the file")
        output.use { stream ->
            FileInputStream(local).use { input ->
                copyStream(input, stream)
            }
            stream.flush()
            if (stream is FileOutputStream) {
                stream.fd.sync()
            }
        }
    }

    private fun copyStream(input: InputStream, output: java.io.OutputStream) {
        val buffer = ByteArray(BUFFER_SIZE)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
        }
    }
}

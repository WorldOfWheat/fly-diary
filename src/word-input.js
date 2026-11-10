// ---------------------------------------------------------------------------
// BIP39 word tiles with prefix suggestions
// ---------------------------------------------------------------------------
//
// Shared by the one-time recovery confirmation and the lock-screen recovery
// form. The wordlist comes from the backend (the same embedded official list
// used for checksum validation), so the UI cannot drift from the crypto code.

let cachedWords = null;
let loading = null;

/** Load and cache the official BIP39 English wordlist. */
export async function loadBip39Words(invoke) {
  if (cachedWords) return cachedWords;
  if (!loading) {
    loading = Promise.resolve()
      .then(() => invoke("get_bip39_words"))
      .then((words) => {
        cachedWords = Array.isArray(words) ? words : [];
        return cachedWords;
      })
      .catch((err) => {
        console.error("get_bip39_words failed:", err);
        cachedWords = [];
        return cachedWords;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** Test helper: forget the cached list between fake backends. */
export function resetWordlistCache() {
  cachedWords = null;
  loading = null;
}

/**
 * Render tile-shaped word inputs into `container`.
 *
 * `entries` is `[{ index, label }]`; the index is the phrase position (1-based
 * position is only used for labels), so the confirmation window can ask for
 * non-adjacent positions while the unlock form uses all twelve in order.
 *
 * Returns field objects with `input`, `element`, `setWords`, `setValue`,
 * `clear`, and `focus`.
 */
export function createWordFields(container, entries, deps) {
  container.replaceChildren();
  const words = deps.words || [];
  const fields = [];

  for (const [position, entry] of entries.entries()) {
    const index = entry.index ?? position;
    const label = entry.label || deps.t("recovery.confirmWord", { n: index + 1 });
    const inputId = `${deps.idPrefix}-${index}`;
    const listId = `${inputId}-suggestions`;

    const element = document.createElement("div");
    element.className = "word-field";
    element.dataset.index = String(index);

    const caption = document.createElement("label");
    caption.className = "word-field-label";
    caption.setAttribute("for", inputId);
    caption.textContent = label;

    const shell = document.createElement("div");
    shell.className = "word-field-shell";

    const number = document.createElement("span");
    number.className = "word-field-index";
    number.textContent = String(index + 1).padStart(2, "0");
    number.setAttribute("aria-hidden", "true");

    const input = document.createElement("input");
    input.id = inputId;
    input.className = "word-field-input";
    input.type = "text";
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.dataset.index = String(index);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", listId);
    input.setAttribute("aria-label", label);

    const list = document.createElement("ul");
    list.id = listId;
    list.className = "word-suggestions";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", deps.t("recovery.suggestionsLabel"));
    list.hidden = true;

    let active = -1;
    let currentWords = words;

    function options() {
      return list.children;
    }

    function setExpanded(expanded) {
      input.setAttribute("aria-expanded", expanded ? "true" : "false");
      if (!expanded) input.removeAttribute("aria-activedescendant");
    }

    function hide() {
      list.replaceChildren();
      list.hidden = true;
      active = -1;
      setExpanded(false);
    }

    function choose(word) {
      if (list.hidden) return;
      input.value = word;
      hide();
      deps.onSelect?.(api, index);
    }

    function renderOptions(matches) {
      list.replaceChildren();
      matches.forEach((word, optionIndex) => {
        const option = document.createElement("li");
        option.className = "word-suggestion";
        option.id = `${listId}-${optionIndex}`;
        option.setAttribute("role", "option");
        option.dataset.word = word;
        option.textContent = word;
        for (const type of ["mousedown", "pointerdown", "touchstart"]) {
          option.addEventListener(type, (event) => {
            event.preventDefault();
            choose(word);
          });
        }
        option.addEventListener("click", () => choose(word));
        list.append(option);
      });
      list.hidden = false;
      setExpanded(true);
    }

    function update() {
      const value = input.value;
      if (/\s/.test(value)) {
        hide();
        return;
      }
      const prefix = value.trim().toLowerCase();
      if (!prefix || currentWords.length === 0) {
        hide();
        return;
      }
      const matches = currentWords
        .filter((word) => word.startsWith(prefix))
        .slice(0, 8);
      if (matches.length === 0 || (matches.length === 1 && matches[0] === prefix)) {
        hide();
        return;
      }
      renderOptions(matches);
      active = -1;
    }

    function move(delta) {
      if (list.hidden) {
        update();
        if (list.hidden) return;
      }
      const items = options();
      if (items.length === 0) return;
      active = (active + delta + items.length) % items.length;
      for (const [i, item] of Array.from(items).entries()) {
        item.setAttribute("aria-selected", i === active ? "true" : "false");
      }
      input.setAttribute("aria-activedescendant", items[active].id);
    }

    input.addEventListener("input", update);
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter" && !list.hidden) {
        const item = options()[active >= 0 ? active : 0];
        if (item) {
          event.preventDefault();
          choose(item.dataset.word);
        }
      } else if (event.key === "Enter" && list.hidden) {
        // Do not submit the whole recovery form from the first tile.
        event.preventDefault();
        deps.onAdvance?.(api, index);
      } else if (event.key === "Escape" && !list.hidden) {
        // Close the suggestion list before the global Escape handler closes
        // the whole recovery dialog.
        hide();
        event.preventDefault?.();
        event.stopPropagation?.();
      } else if (event.key === " " && !/\s/.test(input.value)) {
        const word = input.value.trim().toLowerCase();
        if (word && currentWords.includes(word)) {
          event.preventDefault();
          deps.onAdvance?.(api, index);
        }
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(hide, 120);
    });

    shell.append(number, input);
    element.append(caption, shell, list);
    container.append(element);

    const api = {
      index,
      element,
      input,
      list,
      setWords(next) {
        currentWords = Array.isArray(next) ? next : [];
        update();
      },
      setValue(value) {
        input.value = value;
        hide();
      },
      clear() {
        input.value = "";
        hide();
      },
      focus() {
        input.focus();
      },
    };
    fields.push(api);
  }

  return fields;
}

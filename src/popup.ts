// Toolbar popup: the one control. A single toggle that activates or deactivates the extension. It
// writes the on device config and asks the background to re apply immediately. A richer recap of
// exactly what is hidden on the active tab comes in a later ticket; for now this is just the switch.

import { loadConfig, saveConfig } from "./config";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

async function render(): Promise<void> {
  const enabled = el<HTMLInputElement>("enabled");
  const status = el<HTMLElement>("status");

  const config = await loadConfig();
  enabled.checked = config.enabled;
  status.textContent = config.enabled ? "On, protecting every site." : "Off.";

  enabled.addEventListener("change", () => {
    void (async () => {
      const on = enabled.checked;
      try {
        await saveConfig({ enabled: on });
        await browser.runtime.sendMessage({ type: "poison:apply" });
        status.textContent = on ? "On, protecting every site." : "Off.";
      } catch (err) {
        status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  });
}

// Run immediately if the document is already parsed (DOMContentLoaded may have fired before this
// bundled script executed), otherwise wait for it. Either way render() runs once.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void render());
} else {
  void render();
}

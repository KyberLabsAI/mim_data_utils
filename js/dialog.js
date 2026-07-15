/**
 * Custom inline dialog replacements for alert() and prompt().
 * Native browser dialogs don't work reliably inside iFrames.
 */

const _dialogCSS = `
.custom-dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.35);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
}
.custom-dialog {
    background: white;
    border: 1px solid #888;
    border-radius: 6px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.25);
    min-width: 320px;
    max-width: 520px;
    padding: 16px 20px;
    font-family: system-ui, sans-serif;
    font-size: 14px;
}
.custom-dialog .msg {
    white-space: pre-wrap;
    margin-bottom: 12px;
    line-height: 1.4;
}
.custom-dialog input[type=text] {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    margin-bottom: 12px;
    font-size: 14px;
    border: 1px solid #aaa;
    border-radius: 3px;
}
.custom-dialog .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
.custom-dialog button {
    padding: 5px 16px;
    font-size: 13px;
    border: 1px solid #aaa;
    border-radius: 3px;
    cursor: pointer;
    background: #f0f0f0;
}
.custom-dialog button.primary {
    background: #4a90d9;
    color: white;
    border-color: #3a7bc8;
}
/* Left-docked layout panel (toggled by the "Set Layout" button / "l" hotkey). */
.custom-dialog.layout-panel {
    position: fixed;
    left: 0;
    top: 0;
    height: 100vh;
    width: var(--layout-panel-width, 360px);
    box-sizing: border-box;
    overflow: auto;
    background: #eef0f2;
    border: none;
    border-right: 1px solid #888;
    border-radius: 0;
    box-shadow: none;
    text-align: left;
    z-index: 10000;
}
.layout-panel .msg {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px;
    color: #333;
}
.custom-dialog .layout-input-row {
    display: flex;
    gap: 8px;
    margin-bottom: 6px;
}
.custom-dialog .layout-input-row input[type=text] {
    flex: 1 1 auto;
    margin-bottom: 0;
}
.custom-dialog .layout-input-row button {
    flex: 0 0 auto;
}
.custom-dialog .layout-error {
    color: #c0392b;
    font-size: 12px;
    min-height: 1em;
    margin-bottom: 8px;
}
.custom-dialog .toggle-section {
    border-top: 1px solid #ddd;
    margin-top: 8px;
    padding-top: 8px;
}
.custom-dialog .toggle-section:first-child {
    border-top: none;
    margin-top: 0;
    padding-top: 0;
}
.custom-dialog .layout-legend {
    margin-top: 8px;
    margin-bottom: 0;
}
.custom-dialog .traces-row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
}
.custom-dialog .traces-row input[type=text] {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    font-size: 14px;
    border: 1px solid #aaa;
    border-radius: 3px;
}
/* Keep the "Add trace..." dropdown compact and left-aligned below the input. */
.custom-dialog .traces-row select {
    align-self: flex-start;
}
.custom-dialog .toggle-section h4 {
    margin: 0 0 6px 0;
    font-size: 13px;
}
.custom-dialog .toggle-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 30vh;
    overflow: auto;
}
.custom-dialog .toggle-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    cursor: pointer;
}
.custom-dialog .toggle-row input[type=checkbox] {
    margin: 0;
}
.custom-dialog .toggle-empty {
    font-size: 12px;
    color: #888;
    font-style: italic;
}
`;

// Inject CSS once
(function injectCSS() {
    if (document.getElementById('custom-dialog-style')) return;
    const style = document.createElement('style');
    style.id = 'custom-dialog-style';
    style.textContent = _dialogCSS;
    document.head.appendChild(style);
})();

function _createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'custom-dialog-overlay';
    document.body.appendChild(overlay);
    return overlay;
}

/**
 * Show an alert dialog. Returns a Promise that resolves when dismissed.
 */
function customAlert(message) {
    return new Promise(resolve => {
        const overlay = _createOverlay();
        const dialog = document.createElement('div');
        dialog.className = 'custom-dialog';
        dialog.innerHTML = `
            <div class="msg"></div>
            <div class="buttons">
                <button class="primary ok-btn">OK</button>
            </div>
        `;
        dialog.querySelector('.msg').textContent = message;
        overlay.appendChild(dialog);

        const okBtn = dialog.querySelector('.ok-btn');
        function dismiss() {
            overlay.remove();
            resolve();
        }
        okBtn.addEventListener('click', dismiss);
        okBtn.focus();

        overlay.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === 'Escape') dismiss();
        });
    });
}

/**
 * Show a prompt dialog. Returns a Promise that resolves with the entered
 * string, or null if cancelled.
 */
function customPrompt(message, defaultValue) {
    return new Promise(resolve => {
        const overlay = _createOverlay();
        const dialog = document.createElement('div');
        dialog.className = 'custom-dialog';
        dialog.innerHTML = `
            <div class="msg"></div>
            <input type="text" class="prompt-input">
            <div class="buttons">
                <button class="cancel-btn">Cancel</button>
                <button class="primary ok-btn">OK</button>
            </div>
        `;
        dialog.querySelector('.msg').textContent = message;
        const input = dialog.querySelector('.prompt-input');
        input.value = defaultValue || '';
        overlay.appendChild(dialog);

        function finish(value) {
            overlay.remove();
            resolve(value);
        }

        dialog.querySelector('.ok-btn').addEventListener('click', () => finish(input.value));
        dialog.querySelector('.cancel-btn').addEventListener('click', () => finish(null));

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') finish(input.value);
            if (e.key === 'Escape') finish(null);
        });

        input.focus();
        input.select();
    });
}

/**
 * @name SCPWikiDownDetector
 * @author danjon56
 * @description Adds a toolbar button to manually check scp-wiki.wikidot.com status and view local status history.
 * @version 1.0.0
 */

module.exports = class SCPWikiDownDetector {
    constructor() {
        this.pluginName = "SCPWikiDownDetector";

        this.defaultSettings = {
            checkUrl: "https://scp-wiki.wikidot.com/",
            autoCheckEnabled: true,
            checkIntervalSeconds: 60,
            failThreshold: 10,
            slowResponseThresholdSeconds: 30,
            httpTimeoutSeconds: 45,
            historyLimit: 25
        };

        this.settings = {};
        this.autoCheckTimer = null;
        this.headerObserver = null;
        this.abortController = null;

        this.buttonId = "scp-wiki-detector-toolbar-button";
        this.modalId = "scp-wiki-detector-modal";
        this.styleId = "scp-wiki-detector-style";

        this.consecutiveFailures = 0;
        this.outageState = false;

        this.status = {
            state: "UNKNOWN",
            detail: "No checks have been run yet.",
            responseTimeSeconds: null,
            lastCheckedAt: null
        };

        this.history = [];
    }

    getName() {
        return this.pluginName;
    }

    getAuthor() {
        return "YourName";
    }

    getDescription() {
        return "Adds a toolbar button to manually check scp-wiki.wikidot.com status and view local status history.";
    }

    getVersion() {
        return "2.0.0";
    }

    load() {
        const savedSettings = BdApi.Data.load(this.pluginName, "settings") || {};
        this.settings = Object.assign({}, this.defaultSettings, savedSettings);

        const savedHistory = BdApi.Data.load(this.pluginName, "history") || [];
        this.history = Array.isArray(savedHistory) ? savedHistory : [];

        const savedStatus = BdApi.Data.load(this.pluginName, "status");
        if (savedStatus && typeof savedStatus === "object") {
            this.status = Object.assign({}, this.status, savedStatus);
        }
    }

    start() {
        this.injectStyles();
        this.installHeaderObserver();
        this.injectToolbarButton();

        if (this.settings.autoCheckEnabled) {
            this.startAutoChecks();
        }
    }

    stop() {
        this.stopAutoChecks();
        this.removeToolbarButton();
        this.removeModal();
        this.removeStyles();

        if (this.headerObserver) {
            this.headerObserver.disconnect();
            this.headerObserver = null;
        }

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    saveSettings() {
        BdApi.Data.save(this.pluginName, "settings", this.settings);
    }

    saveState() {
        BdApi.Data.save(this.pluginName, "history", this.history);
        BdApi.Data.save(this.pluginName, "status", this.status);
    }

    startAutoChecks() {
        this.stopAutoChecks();

        this.runCheck(false);

        this.autoCheckTimer = setInterval(() => {
            this.runCheck(false);
        }, this.settings.checkIntervalSeconds * 1000);
    }

    stopAutoChecks() {
        if (this.autoCheckTimer) {
            clearInterval(this.autoCheckTimer);
            this.autoCheckTimer = null;
        }
    }

    installHeaderObserver() {
        this.headerObserver = new MutationObserver(() => {
            this.injectToolbarButton();
        });

        this.headerObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    findToolbar() {
        const selectors = [
            '[class*="toolbar"]',
            '[aria-label="Channel header"] [class*="toolbar"]',
            'section[aria-label="Channel header"] [class*="toolbar"]'
        ];

        for (const selector of selectors) {
            const matches = Array.from(document.querySelectorAll(selector));

            const likelyToolbar = matches.find(element => {
                const rect = element.getBoundingClientRect();
                return rect.width > 80 && rect.height > 20;
            });

            if (likelyToolbar) {
                return likelyToolbar;
            }
        }

        return null;
    }

    injectToolbarButton() {
        if (document.getElementById(this.buttonId)) {
            return;
        }

        const toolbar = this.findToolbar();

        if (!toolbar) {
            return;
        }

        const button = document.createElement("button");
        button.id = this.buttonId;
        button.className = "scp-wiki-detector-button";
        button.type = "button";
        button.title = "SCP Wiki status";
        button.setAttribute("aria-label", "SCP Wiki status");
        button.innerHTML = this.getButtonIcon();

        button.addEventListener("click", () => {
            this.openModal();
        });

        toolbar.prepend(button);
        this.updateToolbarButton();
    }

    removeToolbarButton() {
        const button = document.getElementById(this.buttonId);
        if (button) {
            button.remove();
        }
    }

    getButtonIcon() {
        return `
            <svg class="scp-wiki-detector-icon" width="22" height="22" viewBox="0 0 24 24">
                <path fill="currentColor" d="M12 2L2 7v6c0 5.55 3.84 10.74 10 12 6.16-1.26 10-6.45 10-12V7L12 2zm0 2.18L20 8v5c0 4.52-3.08 8.86-8 10-4.92-1.14-8-5.48-8-10V8l8-3.82z"/>
                <path fill="currentColor" d="M11 7h2v7h-2V7zm0 9h2v2h-2v-2z"/>
            </svg>
        `;
    }

    updateToolbarButton() {
        const button = document.getElementById(this.buttonId);

        if (!button) {
            return;
        }

        button.classList.remove(
            "scp-wiki-detector-unknown",
            "scp-wiki-detector-up",
            "scp-wiki-detector-slow",
            "scp-wiki-detector-down"
        );

        if (this.status.state === "UP") {
            button.classList.add("scp-wiki-detector-up");
        } else if (this.status.state === "SLOW") {
            button.classList.add("scp-wiki-detector-slow");
        } else if (this.status.state === "DOWN") {
            button.classList.add("scp-wiki-detector-down");
        } else {
            button.classList.add("scp-wiki-detector-unknown");
        }

        button.title = `SCP Wiki status: ${this.status.state}\n${this.status.detail}`;
    }

    async checkSite() {
        const startedAt = performance.now();
        const timeoutMs = this.settings.httpTimeoutSeconds * 1000;

        this.abortController = new AbortController();

        const timeout = setTimeout(() => {
            if (this.abortController) {
                this.abortController.abort();
            }
        }, timeoutMs);

        try {
            const response = await fetch(this.settings.checkUrl, {
                method: "GET",
                cache: "no-store",
                redirect: "follow",
                signal: this.abortController.signal
            });

            const elapsedSeconds = (performance.now() - startedAt) / 1000;
            const healthy = response.status >= 200 && response.status < 400;
            const slow = elapsedSeconds >= this.settings.slowResponseThresholdSeconds;

            return {
                healthy,
                slow,
                elapsedSeconds,
                detail: `HTTP ${response.status} in ${elapsedSeconds.toFixed(2)}s`
            };
        } catch (error) {
            const elapsedSeconds = (performance.now() - startedAt) / 1000;
            const name = error && error.name ? error.name : "Error";
            const message = error && error.message ? error.message : String(error);

            return {
                healthy: false,
                slow: false,
                elapsedSeconds,
                detail: `${name}: ${message}`
            };
        } finally {
            clearTimeout(timeout);
            this.abortController = null;
        }
    }

    async runCheck(showToast) {
        const result = await this.checkSite();

        if (result.healthy) {
            this.consecutiveFailures = 0;

            if (result.slow) {
                this.status.state = "SLOW";
            } else {
                this.status.state = "UP";
                this.outageState = false;
            }
        } else {
            this.consecutiveFailures += 1;

            if (this.consecutiveFailures >= this.settings.failThreshold) {
                this.status.state = "DOWN";
                this.outageState = true;
            } else {
                this.status.state = "SLOW";
            }
        }

        this.status.detail = result.detail;
        this.status.responseTimeSeconds = result.elapsedSeconds;
        this.status.lastCheckedAt = new Date().toISOString();

        this.addHistoryEntry({
            timestamp: this.status.lastCheckedAt,
            state: this.status.state,
            detail: this.status.detail,
            responseTimeSeconds: this.status.responseTimeSeconds,
            failureStreak: this.consecutiveFailures
        });

        this.saveState();
        this.updateToolbarButton();
        this.refreshModal();

        if (showToast) {
            BdApi.UI.showToast(`SCP Wiki: ${this.status.state} — ${this.status.detail}`, {
                type: this.getToastType(),
                timeout: 5000
            });
        }

        return result;
    }

    addHistoryEntry(entry) {
        this.history.unshift(entry);

        if (this.history.length > this.settings.historyLimit) {
            this.history = this.history.slice(0, this.settings.historyLimit);
        }
    }

    getToastType() {
        if (this.status.state === "UP") {
            return "success";
        }

        if (this.status.state === "SLOW") {
            return "warning";
        }

        if (this.status.state === "DOWN") {
            return "error";
        }

        return "info";
    }

    openModal() {
        this.removeModal();

        const backdrop = document.createElement("div");
        backdrop.id = this.modalId;
        backdrop.className = "scp-wiki-detector-backdrop";

        backdrop.innerHTML = `
            <div class="scp-wiki-detector-modal">
                <div class="scp-wiki-detector-modal-header">
                    <div>
                        <h2>SCP Wiki Status</h2>
                        <div class="scp-wiki-detector-subtitle">${this.escapeHtml(this.settings.checkUrl)}</div>
                    </div>
                    <button class="scp-wiki-detector-close" type="button" aria-label="Close">×</button>
                </div>

                <div class="scp-wiki-detector-status-card">
                    <div class="scp-wiki-detector-state-row">
                        <span class="scp-wiki-detector-pill ${this.getStateClass()}">${this.escapeHtml(this.status.state)}</span>
                        <span class="scp-wiki-detector-last-check">${this.escapeHtml(this.formatLastChecked())}</span>
                    </div>
                    <div class="scp-wiki-detector-detail">${this.escapeHtml(this.status.detail)}</div>
                    <div class="scp-wiki-detector-meta">
                        Failure streak: ${this.consecutiveFailures}/${this.settings.failThreshold}
                    </div>
                </div>

                <div class="scp-wiki-detector-actions">
                    <button class="scp-wiki-detector-primary" type="button" data-action="check">Run check now</button>
                    <button class="scp-wiki-detector-secondary" type="button" data-action="clear-history">Clear history</button>
                    <button class="scp-wiki-detector-secondary" type="button" data-action="toggle-auto">
                        ${this.settings.autoCheckEnabled ? "Disable auto-checks" : "Enable auto-checks"}
                    </button>
                </div>

                <h3>Status history</h3>
                <div class="scp-wiki-detector-history">
                    ${this.renderHistory()}
                </div>

                <h3>Settings</h3>
                <div class="scp-wiki-detector-settings">
                    ${this.renderSettings()}
                </div>
            </div>
        `;

        document.body.appendChild(backdrop);

        backdrop.addEventListener("click", event => {
            if (event.target === backdrop) {
                this.removeModal();
            }
        });

        backdrop.querySelector(".scp-wiki-detector-close").addEventListener("click", () => {
            this.removeModal();
        });

        backdrop.querySelector('[data-action="check"]').addEventListener("click", async event => {
            const button = event.currentTarget;
            button.disabled = true;
            button.textContent = "Checking...";

            await this.runCheck(true);

            button.disabled = false;
            button.textContent = "Run check now";
        });

        backdrop.querySelector('[data-action="clear-history"]').addEventListener("click", () => {
            this.history = [];
            this.saveState();
            this.refreshModal();
        });

        backdrop.querySelector('[data-action="toggle-auto"]').addEventListener("click", () => {
            this.settings.autoCheckEnabled = !this.settings.autoCheckEnabled;
            this.saveSettings();

            if (this.settings.autoCheckEnabled) {
                this.startAutoChecks();
            } else {
                this.stopAutoChecks();
            }

            this.refreshModal();
        });

        this.attachSettingsHandlers(backdrop);
    }

    refreshModal() {
        const modal = document.getElementById(this.modalId);

        if (!modal) {
            return;
        }

        this.openModal();
    }

    removeModal() {
        const modal = document.getElementById(this.modalId);
        if (modal) {
            modal.remove();
        }
    }

    renderHistory() {
        if (!this.history.length) {
            return `<div class="scp-wiki-detector-empty">No status history yet.</div>`;
        }

        return this.history.map(entry => {
            return `
                <div class="scp-wiki-detector-history-row">
                    <span class="scp-wiki-detector-pill ${this.getStateClass(entry.state)}">${this.escapeHtml(entry.state)}</span>
                    <div class="scp-wiki-detector-history-main">
                        <div>${this.escapeHtml(entry.detail)}</div>
                        <div class="scp-wiki-detector-history-time">
                            ${this.escapeHtml(this.formatDate(entry.timestamp))}
                            · Failure streak: ${Number(entry.failureStreak || 0)}
                        </div>
                    </div>
                </div>
            `;
        }).join("");
    }

    renderSettings() {
        return `
            <label>
                Check URL
                <input type="text" data-setting="checkUrl" value="${this.escapeAttribute(this.settings.checkUrl)}">
            </label>

            <label>
                Check interval, seconds
                <input type="number" min="10" max="86400" data-setting="checkIntervalSeconds" value="${Number(this.settings.checkIntervalSeconds)}">
            </label>

            <label>
                Failure threshold
                <input type="number" min="1" max="100" data-setting="failThreshold" value="${Number(this.settings.failThreshold)}">
            </label>

            <label>
                Slow response threshold, seconds
                <input type="number" min="1" max="300" data-setting="slowResponseThresholdSeconds" value="${Number(this.settings.slowResponseThresholdSeconds)}">
            </label>

            <label>
                HTTP timeout, seconds
                <input type="number" min="1" max="300" data-setting="httpTimeoutSeconds" value="${Number(this.settings.httpTimeoutSeconds)}">
            </label>
        `;
    }

    attachSettingsHandlers(root) {
        const inputs = Array.from(root.querySelectorAll("[data-setting]"));

        for (const input of inputs) {
            input.addEventListener("change", () => {
                const key = input.getAttribute("data-setting");

                if (!key) {
                    return;
                }

                if (input.type === "number") {
                    const value = Number(input.value);

                    if (!Number.isFinite(value)) {
                        return;
                    }

                    this.settings[key] = value;
                } else {
                    this.settings[key] = input.value.trim();
                }

                this.saveSettings();

                if (
                    key === "checkIntervalSeconds" ||
                    key === "httpTimeoutSeconds"
                ) {
                    if (this.settings.autoCheckEnabled) {
                        this.startAutoChecks();
                    }
                }

                this.updateToolbarButton();
            });
        }
    }

    getStateClass(state) {
        const resolvedState = state || this.status.state;

        if (resolvedState === "UP") {
            return "scp-wiki-detector-pill-up";
        }

        if (resolvedState === "SLOW") {
            return "scp-wiki-detector-pill-slow";
        }

        if (resolvedState === "DOWN") {
            return "scp-wiki-detector-pill-down";
        }

        return "scp-wiki-detector-pill-unknown";
    }

    formatLastChecked() {
        if (!this.status.lastCheckedAt) {
            return "Never checked";
        }

        return `Last checked: ${this.formatDate(this.status.lastCheckedAt)}`;
    }

    formatDate(value) {
        try {
            return new Date(value).toLocaleString();
        } catch {
            return "Unknown time";
        }
    }

    escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    escapeAttribute(value) {
        return this.escapeHtml(value).replaceAll("`", "&#096;");
    }

    injectStyles() {
        if (document.getElementById(this.styleId)) {
            return;
        }

        const style = document.createElement("style");
        style.id = this.styleId;
        style.textContent = `
            .scp-wiki-detector-button {
                width: 32px;
                height: 32px;
                border: 0;
                padding: 0;
                margin: 0 4px;
                border-radius: 4px;
                background: transparent;
                color: var(--interactive-normal);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
            }

            .scp-wiki-detector-button:hover {
                color: var(--interactive-hover);
                background: var(--background-modifier-hover);
            }

            .scp-wiki-detector-up {
                color: var(--status-positive, #23a55a);
            }

            .scp-wiki-detector-slow {
                color: var(--status-warning, #f0b232);
            }

            .scp-wiki-detector-down {
                color: var(--status-danger, #f23f42);
            }

            .scp-wiki-detector-unknown {
                color: var(--interactive-muted);
            }

            .scp-wiki-detector-backdrop {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.65);
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .scp-wiki-detector-modal {
                width: 620px;
                max-width: calc(100vw - 40px);
                max-height: calc(100vh - 40px);
                overflow: auto;
                background: var(--background-primary);
                color: var(--text-normal);
                border-radius: 8px;
                box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
                padding: 20px;
            }

            .scp-wiki-detector-modal-header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                gap: 16px;
                margin-bottom: 16px;
            }

            .scp-wiki-detector-modal h2,
            .scp-wiki-detector-modal h3 {
                margin: 0 0 8px 0;
            }

            .scp-wiki-detector-subtitle {
                color: var(--text-muted);
                font-size: 13px;
                margin-top: 4px;
            }

            .scp-wiki-detector-close {
                border: 0;
                background: transparent;
                color: var(--interactive-normal);
                font-size: 26px;
                cursor: pointer;
                line-height: 1;
            }

            .scp-wiki-detector-status-card {
                border: 1px solid var(--background-modifier-accent);
                border-radius: 8px;
                padding: 14px;
                margin-bottom: 16px;
                background: var(--background-secondary);
            }

            .scp-wiki-detector-state-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
                margin-bottom: 10px;
            }

            .scp-wiki-detector-last-check,
            .scp-wiki-detector-meta,
            .scp-wiki-detector-history-time,
            .scp-wiki-detector-empty {
                color: var(--text-muted);
                font-size: 13px;
            }

            .scp-wiki-detector-detail {
                font-size: 15px;
                margin-bottom: 8px;
            }

            .scp-wiki-detector-pill {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 68px;
                border-radius: 999px;
                padding: 4px 10px;
                font-weight: 700;
                font-size: 12px;
            }

            .scp-wiki-detector-pill-up {
                background: rgba(35, 165, 90, 0.18);
                color: var(--status-positive, #23a55a);
            }

            .scp-wiki-detector-pill-slow {
                background: rgba(240, 178, 50, 0.18);
                color: var(--status-warning, #f0b232);
            }

            .scp-wiki-detector-pill-down {
                background: rgba(242, 63, 66, 0.18);
                color: var(--status-danger, #f23f42);
            }

            .scp-wiki-detector-pill-unknown {
                background: rgba(128, 132, 142, 0.18);
                color: var(--text-muted);
            }

            .scp-wiki-detector-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-bottom: 20px;
            }

            .scp-wiki-detector-primary,
            .scp-wiki-detector-secondary {
                border: 0;
                border-radius: 4px;
                padding: 8px 12px;
                cursor: pointer;
                color: var(--button-secondary-text);
            }

            .scp-wiki-detector-primary {
                background: var(--button-positive-background, #248046);
                color: #fff;
            }

            .scp-wiki-detector-primary:hover {
                background: var(--button-positive-background-hover, #1a6334);
            }

            .scp-wiki-detector-secondary {
                background: var(--button-secondary-background, #4e5058);
                color: #fff;
            }

            .scp-wiki-detector-secondary:hover {
                background: var(--button-secondary-background-hover, #6d6f78);
            }

            .scp-wiki-detector-primary:disabled,
            .scp-wiki-detector-secondary:disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }

            .scp-wiki-detector-history {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-bottom: 20px;
            }

            .scp-wiki-detector-history-row {
                display: flex;
                gap: 10px;
                align-items: flex-start;
                border-bottom: 1px solid var(--background-modifier-accent);
                padding-bottom: 8px;
            }

            .scp-wiki-detector-history-main {
                flex: 1;
                min-width: 0;
            }

            .scp-wiki-detector-settings {
                display: grid;
                gap: 10px;
            }

            .scp-wiki-detector-settings label {
                display: grid;
                gap: 4px;
                color: var(--text-muted);
                font-size: 13px;
            }

            .scp-wiki-detector-settings input {
                background: var(--input-background);
                color: var(--text-normal);
                border: 1px solid var(--background-modifier-accent);
                border-radius: 4px;
                padding: 8px;
            }
        `;

        document.head.appendChild(style);
    }

    removeStyles() {
        const style = document.getElementById(this.styleId);
        if (style) {
            style.remove();
        }
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.padding = "16px";

        const title = document.createElement("h2");
        title.textContent = "SCP Wiki Down Detector";
        panel.appendChild(title);

        const note = document.createElement("p");
        note.textContent = "Use the shield/exclamation icon in the channel header to open the status panel.";
        panel.appendChild(note);

        const openButton = document.createElement("button");
        openButton.textContent = "Open status panel";
        openButton.onclick = () => this.openModal();
        panel.appendChild(openButton);

        return panel;
    }
};

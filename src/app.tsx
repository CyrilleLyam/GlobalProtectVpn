import * as Gtk from "@gtkx/gi/gtk";
import {
    AdwActionRow,
    AdwApplication,
    AdwApplicationWindow,
    AdwBanner,
    AdwEntryRow,
    AdwHeaderBar,
    AdwPasswordEntryRow,
    AdwPreferencesGroup,
    AdwPreferencesPage,
    AdwSpinner,
    AdwSwitchRow,
    AdwToolbarView,
} from "@gtkx/jsx/adw";
import { GtkButton, GtkImage, GtkLabel } from "@gtkx/jsx/gtk";
import { quit } from "@gtkx/react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as vpn from "./vpn.js";

type Phase = "idle" | "connecting" | "disconnecting" | "installing";

const MAX_LOG_LINES = 40;

const MainWindow = () => {
    const [settings, setSettings] = useState(vpn.loadSettings);
    const [status, setStatus] = useState<vpn.VpnStatus>({ connected: false, tunnelAddress: null });
    const [helperReady, setHelperReady] = useState(true);
    const [gpclientInstalled, setGpclientInstalled] = useState(vpn.isGpclientInstalled);
    const [phase, setPhase] = useState<Phase>("idle");
    const [log, setLog] = useState("");
    const cancelConnect = useRef<(() => void) | null>(null);

    const appendLog = useCallback((chunk: string) => {
        setLog((current) => (current + chunk).split("\n").slice(-MAX_LOG_LINES).join("\n"));
    }, []);

    const refreshStatus = useCallback(async () => setStatus(await vpn.getStatus()), []);

    useEffect(() => {
        void vpn.isSetUp().then(setHelperReady);
        void refreshStatus();
        const timer = setInterval(() => void refreshStatus(), 3000);
        return () => clearInterval(timer);
    }, [refreshStatus]);

    const update = (patch: Partial<vpn.Settings>) => setSettings((current) => ({ ...current, ...patch }));

    const serverValid = vpn.isValidServer(settings.server.trim());
    const userValid = vpn.isValidUser(settings.user.trim());
    const busy = phase !== "idle";

    const install = async () => {
        setPhase("installing");
        setLog("");
        const { code } = await vpn.runSetup(appendLog);
        if (code !== 0) appendLog(`\nSetup failed (exit ${code}).`);
        setGpclientInstalled(vpn.isGpclientInstalled());
        setHelperReady(await vpn.isSetUp());
        setPhase("idle");
    };

    const connect = async () => {
        const server = settings.server.trim();
        const user = settings.user.trim();
        vpn.saveSettings({ ...settings, server, user });
        setLog("");
        setPhase("connecting");
        const job = vpn.connect(server, user, settings.password, appendLog);
        cancelConnect.current = job.cancel;
        const { code } = await job.result;
        cancelConnect.current = null;
        if (code !== 0) appendLog(`\ngpclient exited with code ${code}.`);
        await refreshStatus();
        setPhase("idle");
    };

    const disconnect = async () => {
        setPhase("disconnecting");
        cancelConnect.current?.();
        await vpn.disconnect(appendLog);
        await refreshStatus();
        setPhase("idle");
    };

    const statusTitle = {
        idle: status.connected ? "Connected" : "Disconnected",
        connecting: "Connecting…",
        disconnecting: "Disconnecting…",
        installing: status.connected ? "Connected" : "Disconnected",
    }[phase];

    const statusSubtitle = status.connected
        ? `VPN address ${status.tunnelAddress ?? "unknown"}`
        : "Not connected to the VPN";

    const showDisconnect = status.connected || phase === "connecting";

    return (
        <AdwApplicationWindow title="GlobalProtect VPN" defaultWidth={440} defaultHeight={640} onCloseRequest={quit}>
            <AdwToolbarView
                topBar={
                    <>
                        <AdwHeaderBar />
                        <AdwBanner
                            revealed={!helperReady}
                            title={
                                phase === "installing"
                                    ? "Setting up…"
                                    : gpclientInstalled
                                      ? "Passwordless sudo is not set up yet"
                                      : "GlobalProtect client (gpclient) is not installed"
                            }
                            buttonLabel={phase === "installing" ? "" : gpclientInstalled ? "Set Up" : "Install"}
                            onButtonClicked={() => void install()}
                        />
                    </>
                }
            >
                <AdwPreferencesPage>
                    <AdwPreferencesGroup>
                        <AdwActionRow
                            title={statusTitle}
                            subtitle={statusSubtitle}
                            subtitleSelectable
                            prefix={
                                busy ? (
                                    <AdwSpinner />
                                ) : (
                                    <GtkImage
                                        iconName={status.connected ? "network-vpn-symbolic" : "network-vpn-disabled-symbolic"}
                                        pixelSize={24}
                                        cssClasses={status.connected ? ["success"] : ["dim-label"]}
                                    />
                                )
                            }
                        />
                    </AdwPreferencesGroup>

                    <AdwPreferencesGroup title="Connection">
                        <AdwEntryRow
                            title="Server IP address"
                            text={settings.server}
                            editable={!busy && !status.connected}
                            cssClasses={serverValid ? [] : ["error"]}
                            onChanged={(self) => update({ server: self.getText() })}
                        />
                        <AdwEntryRow
                            title="Username"
                            text={settings.user}
                            editable={!busy && !status.connected}
                            cssClasses={userValid ? [] : ["error"]}
                            onChanged={(self) => update({ user: self.getText() })}
                        />
                        <AdwPasswordEntryRow
                            title="Password"
                            text={settings.password}
                            editable={!busy && !status.connected}
                            onChanged={(self) => update({ password: self.getText() })}
                            onEntryActivated={() => void connect()}
                        />
                        <AdwSwitchRow
                            title="Remember password"
                            subtitle="Stored unencrypted in ~/.config/gclient"
                            active={settings.rememberPassword}
                            onNotifyActive={(active) => update({ rememberPassword: active === true })}
                        />
                    </AdwPreferencesGroup>

                    <AdwPreferencesGroup>
                        {showDisconnect ? (
                            <GtkButton
                                label={phase === "connecting" ? "Cancel" : "Disconnect"}
                                halign={Gtk.Align.CENTER}
                                sensitive={helperReady && phase !== "disconnecting"}
                                cssClasses={["destructive-action", "pill"]}
                                onClicked={() => void disconnect()}
                            />
                        ) : (
                            <GtkButton
                                label="Connect"
                                halign={Gtk.Align.CENTER}
                                sensitive={helperReady && !busy && serverValid && userValid}
                                cssClasses={["suggested-action", "pill"]}
                                onClicked={() => void connect()}
                            />
                        )}
                    </AdwPreferencesGroup>

                    {log ? (
                        <AdwPreferencesGroup title="Output">
                            <GtkLabel
                                label={log.trim()}
                                selectable
                                wrap
                                xalign={0}
                                cssClasses={["monospace", "dim-label", "caption"]}
                            />
                        </AdwPreferencesGroup>
                    ) : null}
                </AdwPreferencesPage>
            </AdwToolbarView>
        </AdwApplicationWindow>
    );
};

export const App = () => (
    <AdwApplication>
        <MainWindow />
    </AdwApplication>
);

export default App;

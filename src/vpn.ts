import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const GPCLIENT_PATH = "/usr/bin/gpclient";
export const HELPER_PATH = "/usr/local/sbin/gclient-vpn";
const SUDOERS_PATH = "/etc/sudoers.d/gclient-vpn";
const LOCK_FILE = "/var/run/gpclient.lock";

// Runs as root through sudo. It only accepts `connect <server> [user]` and
// `disconnect`, so the NOPASSWD rule cannot be used to pass gpclient options
// like --script or --hip that would run arbitrary programs as root.
const HELPER_SCRIPT = `#!/bin/sh
set -eu
GPCLIENT=${GPCLIENT_PATH}
usage() { echo "usage: gclient-vpn connect <server> [user] | disconnect" >&2; exit 2; }
[ $# -ge 1 ] || usage
case "$1" in
connect)
    [ $# -ge 2 ] && [ $# -le 3 ] || usage
    printf '%s' "$2" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9.:-]{0,252}' || { echo "invalid server address" >&2; exit 2; }
    if [ $# -eq 3 ]; then
        printf '%s' "$3" | grep -Eqx '[A-Za-z0-9][-A-Za-z0-9._@+]{0,127}' || { echo "invalid username" >&2; exit 2; }
        exec "$GPCLIENT" --fix-openssl --ignore-tls-errors connect --background --user "$3" --passwd-on-stdin "$2"
    fi
    exec "$GPCLIENT" --fix-openssl --ignore-tls-errors connect --background "$2"
    ;;
disconnect)
    [ $# -eq 1 ] || usage
    exec "$GPCLIENT" disconnect
    ;;
*)
    usage
    ;;
esac
`;

// Run once through pkexec: installs gpclient from the upstream PPA when it is
// missing, then the helper and a sudoers rule letting the given user run it
// without a password. visudo checks the rule before it lands.
const INSTALL_SCRIPT = `set -eu
user="$1"
helper="$2"
if [ ! -x ${GPCLIENT_PATH} ]; then
    echo "Installing gpclient from ppa:yuezk/globalprotect-openconnect…"
    export DEBIAN_FRONTEND=noninteractive
    command -v add-apt-repository >/dev/null || apt-get install -y software-properties-common
    add-apt-repository -y ppa:yuezk/globalprotect-openconnect
    apt-get update
    apt-get install -y globalprotect-openconnect
fi
install -o root -g root -m 0755 "$helper" ${HELPER_PATH}
rule=$(mktemp)
printf '%s ALL=(root) NOPASSWD: ${HELPER_PATH}\\n' "$user" > "$rule"
visudo -cqf "$rule"
install -o root -g root -m 0440 "$rule" ${SUDOERS_PATH}
rm -f "$rule"
`;

export type RunResult = { code: number; output: string };

const run = (
    command: string,
    args: string[],
    options: { stdin?: string; onOutput?: (chunk: string) => void } = {},
): { result: Promise<RunResult>; cancel: () => void } => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const collect = (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        options.onOutput?.(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");

    // gpclient --background leaves a daemon holding the pipes open, so wait
    // for the process to exit rather than for the streams to close.
    const result = new Promise<RunResult>((resolve) => {
        child.on("error", (error) => resolve({ code: -1, output: output + error.message }));
        child.on("exit", (code, signal) => resolve({ code: code ?? (signal ? 128 : -1), output }));
    });
    return { result, cancel: () => child.kill("SIGTERM") };
};

export const isGpclientInstalled = () => existsSync(GPCLIENT_PATH);

export const isSetUp = async (): Promise<boolean> => {
    if (!isGpclientInstalled() || !existsSync(HELPER_PATH)) return false;
    const { code } = await run("sudo", ["-n", "-l", HELPER_PATH]).result;
    return code === 0;
};

export const runSetup = async (onOutput: (chunk: string) => void): Promise<RunResult> => {
    const dir = mkdtempSync(join(tmpdir(), "gclient-"));
    try {
        const helper = join(dir, "gclient-vpn");
        writeFileSync(helper, HELPER_SCRIPT, { mode: 0o755 });
        return await run("pkexec", ["sh", "-c", INSTALL_SCRIPT, "sh", userInfo().username, helper], { onOutput }).result;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

export const connect = (
    server: string,
    user: string,
    password: string,
    onOutput: (chunk: string) => void,
) => {
    const args = ["-n", HELPER_PATH, "connect", server];
    if (user) args.push(user);
    return run("sudo", args, { stdin: user ? `${password}\n` : "", onOutput });
};

export const disconnect = (onOutput: (chunk: string) => void) =>
    run("sudo", ["-n", HELPER_PATH, "disconnect"], { onOutput }).result;

export type VpnStatus = { connected: boolean; tunnelAddress: string | null };

const findTunnelAddress = async (): Promise<string | null> => {
    const { code, output } = await run("ip", ["-4", "-o", "addr", "show"]).result;
    if (code !== 0) return null;
    for (const line of output.split("\n")) {
        const match = /^\d+:\s+(tun\S*|gpd\S*)\s+inet\s+([\d.]+)/.exec(line);
        if (match?.[2]) return match[2];
    }
    return null;
};

export const getStatus = async (): Promise<VpnStatus> => {
    let connected = false;
    try {
        const pid = Number.parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
        connected = Number.isInteger(pid) && pid > 0 && existsSync(`/proc/${pid}`);
    } catch {
        connected = false;
    }
    return { connected, tunnelAddress: connected ? await findTunnelAddress() : null };
};

export const isValidServer = (value: string) => /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(value);
export const isValidUser = (value: string) => value === "" || /^[A-Za-z0-9][-A-Za-z0-9._@+]{0,127}$/.test(value);

export type Settings = { server: string; user: string; password: string; rememberPassword: boolean };

const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gclient");
const settingsPath = join(configDir, "settings.json");

export const DEFAULT_SETTINGS: Settings = {
    server: "",
    user: "",
    password: "",
    rememberPassword: false,
};

export const loadSettings = (): Settings => {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(settingsPath, "utf8")) };
    } catch {
        return DEFAULT_SETTINGS;
    }
};

export const saveSettings = (settings: Settings) => {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const stored = settings.rememberPassword ? settings : { ...settings, password: "" };
    writeFileSync(settingsPath, `${JSON.stringify(stored, null, 4)}\n`, { mode: 0o600 });
};

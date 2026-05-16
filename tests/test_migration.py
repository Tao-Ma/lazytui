"""Tests verifying do.sh → dev9.yml migration produces correct RunnableActions.

Each test parses the real dev9.yml and asserts the parsed action matches
the expected shell logic from the corresponding do.sh command.
"""
from __future__ import annotations

from pathlib import Path

from parser import parse

DEV9_YML = Path(__file__).parents[3] / "dev9.yml"


def _get(group: str, action: str):
    cfg = parse(str(DEV9_YML))
    return cfg.groups[group].actions[action]


# ============================================================
# Round 1: Simple one-liners (direct shell commands)
# ============================================================

# --- dev9-core ---

def test_dev9_core_down():
    a = _get("dev9-core", "down")
    assert a.script == "docker compose down"
    assert a.type == "run"
    assert a.label == "Stop"
    assert a.confirm == "Stop all core services?"


def test_dev9_core_status():
    a = _get("dev9-core", "status")
    assert a.script == "docker compose ps"
    assert a.type == "run"
    assert a.label == "Status"
    assert a.confirm is None


def test_dev9_core_logs():
    a = _get("dev9-core", "logs")
    assert a.script == "docker compose logs -f --tail=50"
    assert a.type == "spawn"
    assert a.label == "Logs"


def test_dev9_core_up():
    a = _get("dev9-core", "up")
    # do.sh's `dev9-core up` runs `docker compose up -d --build` then prints
    # the follow-up hint; YAML matches both lines.
    assert "docker compose up -d --build" in a.script
    assert "Next:" in a.script
    assert "dev9 up" in a.script
    assert a.type == "run"
    assert a.label == "Start"


# --- dev9 (dev9-env standalone compose) ---

def test_dev9_status():
    a = _get("dev9", "status")
    assert a.script == "docker compose -f services/dev9/docker-compose.yml ps"
    assert a.type == "run"
    assert a.label == "Status"


def test_dev9_logs():
    a = _get("dev9", "logs")
    assert a.script == "docker compose -f services/dev9/docker-compose.yml logs -f --tail=50"
    assert a.type == "spawn"


def test_dev9_up():
    a = _get("dev9", "up")
    # @use init_ssh expanded — auto-creates SSH key if absent (do.sh: dev9 up
    # runs _init_ssh when $KEY_FILE is missing)
    assert "ssh-keygen" in a.script
    assert "client/id_ed25519" in a.script
    assert "docker compose -f services/dev9/docker-compose.yml up -d --build" in a.script
    assert a.type == "run"
    assert a.debug.helpers_used == ["init_ssh"]


def test_dev9_down():
    a = _get("dev9", "down")
    assert a.script == "docker compose -f services/dev9/docker-compose.yml down"
    assert a.type == "run"
    assert a.confirm == "Stop dev9-env?"


# --- work ---

def test_work_up():
    a = _get("work", "up")
    assert a.script == "docker compose -f services/workvpn/docker-compose.yml up -d --build"
    assert a.type == "run"
    assert a.label == "Start"


def test_work_down():
    a = _get("work", "down")
    assert a.script == "docker compose -f services/workvpn/docker-compose.yml down"
    assert a.type == "run"
    assert a.confirm == "Stop work VPN?"


def test_work_logs():
    a = _get("work", "logs")
    assert a.script == "docker compose -f services/workvpn/docker-compose.yml logs -f"
    assert a.type == "spawn"


# --- dev9-vpn ---

def test_dev9_vpn_up():
    a = _get("dev9-vpn", "up")
    assert a.script == "docker compose -f services/vpnclient/docker-compose.yml up -d --build"
    assert a.type == "run"
    assert a.label == "Connect"


def test_dev9_vpn_down():
    a = _get("dev9-vpn", "down")
    assert a.script == "docker compose -f services/vpnclient/docker-compose.yml down"
    assert a.type == "run"
    assert a.confirm == "Disconnect VPN?"


def test_dev9_vpn_logs():
    a = _get("dev9-vpn", "logs")
    assert a.script == "docker compose -f services/vpnclient/docker-compose.yml logs -f"
    assert a.type == "spawn"


# ============================================================
# Round 2: Commands using vars ($KEY_FILE resolved)
# ============================================================

def test_dev9_vpn_ssh():
    a = _get("dev9-vpn", "ssh")
    assert a.type == "spawn"
    assert a.label == "SSH"
    # $KEY_FILE resolved
    assert "client/id_ed25519" in a.script
    assert "StrictHostKeyChecking=no" in a.script
    assert "ProxyCommand" in a.script
    assert "172.30.0.201" in a.script
    # do.sh forwards extra positional args via "${@:2}" — YAML mirrors with "$@"
    assert '"$@"' in a.script
    assert a.args == "[remote-cmd...]"
    assert a.debug.vars_used["KEY_FILE"] == "client/id_ed25519"


def test_dev9_vpn_check():
    a = _get("dev9-vpn", "check")
    assert a.type == "run"
    assert a.label == "Check"
    # Health check script content
    assert "docker exec dev9-vpnclient" in a.script
    assert "172.30.0.202" in a.script  # gitea
    assert "172.30.0.206" in a.script  # status
    assert "curl" in a.script
    # No vars used — script: but no $VAR from vars block
    assert a.debug.vars_used == {}


# ============================================================
# Round 3: Commands using helpers (@use + vars)
# ============================================================

def test_dev9_core_init():
    a = _get("dev9-core", "init")
    assert a.type == "run"
    assert a.label == "Init"
    assert a.confirm == "Initialize SSH keys + VPN server?"
    # @use init_ssh expanded — contains the ssh-keygen logic
    assert "ssh-keygen" in a.script
    assert "client/id_ed25519" in a.script  # $KEY_FILE resolved
    assert "client" in a.script  # $CLIENT_DIR resolved
    assert a.debug.helpers_used == ["init_ssh"]
    assert "KEY_FILE" in a.debug.vars_used
    assert "CLIENT_DIR" in a.debug.vars_used


def test_dev9_vpn_browse():
    a = _get("dev9-vpn", "browse")
    assert a.type == "background"
    assert a.label == "Browse"
    assert "Google Chrome" in a.script
    assert "http://127.0.0.1:10080" in a.script
    assert ".chrome/dev9-vpn" in a.script
    assert "172.30.0.206:8080" in a.script
    assert "CHROME" in a.debug.vars_used


# work/browse intentionally absent — do.sh has no such subcommand and the
# proxies have no host port (per CLAUDE.md). Removed in parity sweep
# (Step 6 of tools/cli/PLAN.md).


# ============================================================
# Round 4: New groups (build + maintenance)
# ============================================================

# --- build ---

def test_build_image():
    a = _get("build", "image")
    # do.sh build image targets the services/dev9 standalone compose
    assert a.script == "docker compose -f services/dev9/docker-compose.yml build"
    assert a.type == "run"
    assert a.label == "Build Image"


def test_build_rebuild():
    a = _get("build", "rebuild")
    # Tear down dependent (services/dev9) first, then base (root). Bring up base
    # first so dev9net exists before services/dev9 attaches to it.
    assert "docker compose -f services/dev9/docker-compose.yml down" in a.script
    assert "docker compose down" in a.script
    assert "docker compose up -d --build --force-recreate" in a.script
    assert "docker compose -f services/dev9/docker-compose.yml up -d --build --force-recreate" in a.script
    assert a.type == "run"
    assert a.confirm == "Rebuild all services?"


def test_build_tools():
    a = _get("build", "tools")
    assert a.script == "./tools/build-all.sh"
    assert a.type == "run"


def test_build_tools_install():
    a = _get("build", "tools-install")
    assert a.script == "./tools/install.sh"
    assert a.type == "run"


# --- maintenance ---

def test_maintenance_rotate_host_keys():
    a = _get("maintenance", "rotate-host-keys")
    assert a.type == "run"
    assert a.confirm == "Regenerate all SSH host keys?"
    assert "ssh-keygen -t ed25519" in a.script
    assert "ssh-keygen -t rsa" in a.script
    assert "ssh-keygen -t ecdsa" in a.script
    assert "data/ssh-host" in a.script


def test_maintenance_image_save():
    a = _get("maintenance", "image-save")
    assert a.type == "run"
    assert "docker save" in a.script
    assert "image_backup" in a.script
    assert "dev9-env" in a.script


def test_maintenance_image_load():
    a = _get("maintenance", "image-load")
    assert a.type == "run"
    assert "docker load" in a.script
    assert "image_backup" in a.script


# ============================================================
# Diagnostic commands (dev9-vpn ip, ddns-check, ddns-ping)
# ============================================================

def test_dev9_vpn_ip():
    a = _get("dev9-vpn", "ip")
    assert a.type == "run"
    assert a.label == "Show IPs"
    assert "ipconfig getifaddr en0" in a.script
    assert "colima" in a.script
    assert "MacBook LAN IP" in a.script


def test_dev9_vpn_ddns_check():
    a = _get("dev9-vpn", "ddns-check")
    assert a.type == "run"
    assert a.label == "DDNS Check"
    assert "noip.env" in a.script
    assert "dig +short" in a.script
    assert "RESULT:" in a.script


def test_dev9_vpn_ddns_ping():
    a = _get("dev9-vpn", "ddns-ping")
    assert a.type == "run"
    assert a.label == "DDNS Ping"
    assert a.args == "[host]"
    assert "9999" in a.script
    assert "RESULT:" in a.script


# ============================================================
# Argument commands (init, gen, run, archive, archive-verify)
# ============================================================

def test_dev9_vpn_run():
    a = _get("dev9-vpn", "run")
    assert a.type == "spawn"
    assert a.args == "command [args...]"
    assert "http_proxy=http://127.0.0.1:10080" in a.script
    assert "HTTPS_PROXY" in a.script
    assert 'exec "$@"' in a.script


def test_dev9_vpn_init():
    a = _get("dev9-vpn", "init")
    assert a.type == "spawn"  # interactive — needs terminal
    assert a.label == "Init VPN Server"
    assert a.confirm is not None
    assert "ovpn_genconfig" in a.script
    assert "ovpn_initpki" in a.script
    assert "data/openvpn" in a.script  # $OVPN_DATA resolved
    assert a.debug.vars_used["OVPN_DATA"] == "data/openvpn"


def test_dev9_vpn_gen():
    a = _get("dev9-vpn", "gen")
    assert a.type == "run"
    assert a.label == "Generate Client"
    assert a.args == "client-name"
    assert "easyrsa build-client-full" in a.script
    assert "ovpn_getclient" in a.script
    assert "client" in a.script  # $CLIENT_DIR resolved
    assert a.debug.vars_used["CLIENT_DIR"] == "client"


def test_maintenance_archive():
    a = _get("maintenance", "archive")
    assert a.type == "run"
    assert a.args == "dir"
    assert "tar -cJf" in a.script
    assert "data/git" in a.script
    assert "shasum -a 256" in a.script


def test_maintenance_archive_verify():
    a = _get("maintenance", "archive-verify")
    assert a.type == "run"
    assert a.args == "file"
    assert "shasum -a 256 -c" in a.script


# ============================================================
# Config commands (save, load, check-stale)
# ============================================================

def test_config_save():
    a = _get("config", "save")
    assert a.type == "run"
    assert a.label == "Save"
    assert a.args == "[name]"
    assert a.confirm is None
    # Worktree setup inlined
    assert "git" in a.script
    assert "worktree add" in a.script
    assert "worktree remove" in a.script
    # @use config_copy_to expanded
    assert "COPY_SRC" in a.script
    assert "cp -a" in a.script
    assert a.debug.helpers_used == ["config_copy_to"]
    # Commit logic
    assert "diff --cached --quiet" in a.script
    assert "Config saved" in a.script


def test_config_load():
    a = _get("config", "load")
    assert a.type == "run"
    assert a.label == "Load"
    assert a.args == "[name]"
    assert a.confirm is not None
    # Worktree + stale check
    assert "worktree add" in a.script
    assert "diff -rq" in a.script
    assert "unsaved changes" in a.script
    # Uses config_copy_to twice (once for tmpdir, once for restore)
    assert a.script.count("cp -a") > 5  # copy helper expanded twice
    assert "Config loaded" in a.script


def test_config_check_stale():
    a = _get("config", "check-stale")
    assert a.type == "run"
    assert a.label == "Check Stale"
    assert a.args == "[name]"
    assert "worktree add" in a.script
    assert "diff -rq" in a.script
    assert "OK: configs are up to date" in a.script
    assert "STALE:" in a.script
    assert a.debug.helpers_used == ["config_copy_to"]


# ============================================================
# Structure: verify all groups present
# ============================================================

def test_all_groups_present():
    cfg = parse(str(DEV9_YML))
    expected = {"dev9-core", "dev9", "dev9-vpn", "work", "config", "build", "maintenance"}
    assert set(cfg.groups.keys()) == expected


# ============================================================
# Config files section
# ============================================================

def test_files_populated():
    cfg = parse(str(DEV9_YML))
    assert len(cfg.files) > 10


def test_files_ssh_key():
    cfg = parse(str(DEV9_YML))
    keys = {cf.path: cf for cf in cfg.files}
    assert "client/id_ed25519" in keys
    cf = keys["client/id_ed25519"]
    assert cf.var == "KEY_FILE"
    assert cf.desc is not None


def test_files_with_exclude():
    cfg = parse(str(DEV9_YML))
    keys = {cf.path: cf for cf in cfg.files}
    cf = keys["data/cliproxyapi/"]
    assert "logs/" in cf.exclude
    assert "static/" in cf.exclude


def test_files_var_linkage():
    cfg = parse(str(DEV9_YML))
    keys = {cf.path: cf for cf in cfg.files}
    assert keys["data/openvpn/"].var == "OVPN_DATA"


def test_files_all_have_desc():
    cfg = parse(str(DEV9_YML))
    for cf in cfg.files:
        assert cf.desc is not None, f"{cf.path} missing desc"


def test_config_copy_to_auto_generated():
    """config_copy_to helper should be auto-generated, not hand-written."""
    cfg = parse(str(DEV9_YML))
    a = cfg.groups["config"].actions["save"]
    assert "config_copy_to" in a.debug.helpers_used
    # Generated script has cp -a for each file
    assert 'cp -a "$COPY_SRC/client/id_ed25519"' in a.script
    assert 'cp -a "$COPY_SRC/data/dev9/bashrc"' in a.script
    assert 'rsync -a' in a.script  # cliproxyapi with excludes
    assert '$COPY_SRC/client/*.ovpn' in a.script  # glob pattern


def test_config_copy_to_covers_config_branch():
    """Generated config_copy_to must cover all files in the config branch."""
    import fnmatch, subprocess, tempfile
    cfg = parse(str(DEV9_YML))
    patterns = [cf.path for cf in cfg.files]

    # Checkout config branch into worktree
    repo = str(Path(DEV9_YML).parent)
    wtdir = tempfile.mkdtemp()
    try:
        subprocess.run(
            ["git", "-C", repo, "worktree", "add", wtdir, "config", "--quiet"],
            check=True, capture_output=True,
        )
        result = subprocess.run(
            ["find", wtdir, "-type", "f"],
            capture_output=True, text=True,
        )
        branch_files = sorted(
            l.replace(wtdir + "/", "")
            for l in result.stdout.strip().split("\n")
            if ".git" not in l and l.strip()
        )
    finally:
        subprocess.run(
            ["git", "-C", repo, "worktree", "remove", wtdir, "--force"],
            capture_output=True,
        )

    # Check every file is matched by at least one pattern
    unmatched = []
    for f in branch_files:
        found = False
        for p in patterns:
            if p.endswith("/"):
                if f.startswith(p):
                    found = True
                    break
            elif "*" in p:
                if fnmatch.fnmatch(f, p):
                    found = True
                    break
            elif f == p:
                found = True
                break
        if not found:
            unmatched.append(f)

    assert unmatched == [], f"Files not covered by files: {unmatched}"

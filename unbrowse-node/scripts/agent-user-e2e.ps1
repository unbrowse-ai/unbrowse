# End to end, on a real Windows machine in an Administrator shell (CI): `agent-user install` makes the agents' OS user,
# a standard user with no access to the owner's folder, and `remove` undoes it all. `run` and `status` start a process
# with the agent user's logon, which Windows allows only from an interactive session: from session 0 (a service, as a
# CI runner is) they must fail loudly, never pass. usage: scripts/agent-user-e2e.ps1 <path to unbrowse-node.exe>
$ErrorActionPreference = 'Stop'
$bin = (Resolve-Path $args[0]).Path
$env:UNBROWSE_HOME = Join-Path $env:USERPROFILE '.unbrowse-agent-user-e2e'
Remove-Item -Recurse -Force $env:UNBROWSE_HOME -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:UNBROWSE_HOME | Out-Null
Set-Content -NoNewline -Path (Join-Path $env:UNBROWSE_HOME 'owner.token') -Value 'owner-secret'
function Fail($why) { Write-Output "FAIL: $why"; & $bin agent-user remove --yes 2>$null; exit 1 }
$session = (Get-Process -Id $PID).SessionId
Write-Output "session $session, interactive $([Environment]::UserInteractive)"

& $bin agent-user install --yes; if ($LASTEXITCODE) { Fail 'install' }
$u = Get-LocalUser -Name 'unbrowse-agent' -ErrorAction SilentlyContinue; if (-not $u) { Fail 'no user' }
$admins = Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.Name -like '*\unbrowse-agent' }
if ($admins) { Fail 'the agent user is an Administrator' }
# No access rule on the owner's folder lets the agent user, or any group it is in, in.
$open = (Get-Acl $env:UNBROWSE_HOME).Access | Where-Object { $_.IdentityReference -match 'unbrowse-agent|\\Users$|Everyone|Authenticated Users|INTERACTIVE' }
if ($open) { Fail "the owner's folder lets in: $($open.IdentityReference -join ', ')" }
# The agent's own folder: the agent user, the owner and SYSTEM, nothing inherited.
$mine = (Get-Acl 'C:\ProgramData\Unbrowse\agent').Access | Where-Object { $_.IdentityReference -notmatch 'unbrowse-agent|SYSTEM' -and $_.IdentityReference -notmatch [regex]::Escape($env:USERNAME) }
if ($mine) { Fail "the agent's folder also lets in: $($mine.IdentityReference -join ', ')" }

$token = Join-Path $env:UNBROWSE_HOME 'owner.token'
& $bin agent-user run -- powershell -NoProfile -Command "if (`$env:USERNAME -ne 'unbrowse-agent') { exit 4 }; if (-not `$env:UNBROWSE_AGENT_TOKEN) { exit 3 }; try { Get-Content -ErrorAction Stop '$token' | Out-Null; exit 5 } catch { exit 0 }"
$ran = $LASTEXITCODE
& $bin agent-user status
$checked = $LASTEXITCODE
if ($session -eq 0) {
    # A service session: starting a process as another user fails here, and must say so.
    if ($ran -eq 0 -or $checked -eq 0) { Fail "run ($ran) or status ($checked) passed from session 0, where no process can start as another user" }
    Write-Output "run and status fail loudly from session 0, as they must ($ran, $checked)"
} else {
    if ($ran) { Fail "run as the agent user: exit $ran (3: no token, 4: not the agent user, 5: read owner.token)" }
    if ($checked) { Fail 'status found something of the owner''s the agent user can read' }
}
& $bin agent-user remove --yes; if ($LASTEXITCODE) { Fail 'remove' }
if (Get-LocalUser -Name 'unbrowse-agent' -ErrorAction SilentlyContinue) { Fail 'the user is still there' }
if (Test-Path 'C:\ProgramData\Unbrowse\agent') { Fail "the agent's folder is still there" }
Remove-Item -Recurse -Force $env:UNBROWSE_HOME
Write-Output 'AGENT_USER_E2E_PASSED'

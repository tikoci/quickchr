# Run one QEMU case for probe.ts and report how it ended, as one JSON line.
#
# Bun reports only the low byte of a Windows exit status (0xC000001D shows as 29),
# so the probe runs QEMU through .NET's Process instead: ExitCode is the full
# 32-bit status, and the deadline kill is recorded only when it hit a live process.
#
# Input: $env:PROBE_CASE = {"file": "...", "args": ["..."], "timeoutMs": 8000}
# Needs PowerShell 7 (pwsh): ProcessStartInfo.ArgumentList is .NET Core only.
$ErrorActionPreference = 'Stop'
$case = $env:PROBE_CASE | ConvertFrom-Json
$psi = [System.Diagnostics.ProcessStartInfo]::new([string]$case.file)
foreach ($a in $case.args) { $psi.ArgumentList.Add([string]$a) }
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = [System.Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.ReadToEndAsync()
$err = $p.StandardError.ReadToEndAsync()
$killed = $false
if (-not $p.WaitForExit([int]$case.timeoutMs)) {
    if (-not $p.HasExited) {
        $p.Kill($true)
        $killed = $true
    }
}
$p.WaitForExit()
$sw.Stop()
[PSCustomObject]@{
    killedAtDeadline = $killed
    exitCode         = $p.ExitCode
    exitCodeHex      = '0x{0:X8}' -f $p.ExitCode
    ms               = $sw.ElapsedMilliseconds
    output           = "$($out.Result)$($err.Result)"
} | ConvertTo-Json -Compress

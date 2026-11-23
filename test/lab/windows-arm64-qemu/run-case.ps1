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

# Process.Kill() can silently return if the child exits before it is killed.
# Use the Windows termination result to distinguish that race from a kill.
Add-Type -Name ProcessControl -Namespace QuickChrLab -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
[return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
public static extern bool TerminateProcess(Microsoft.Win32.SafeHandles.SafeProcessHandle process, uint exitCode);
'@

$psi = [System.Diagnostics.ProcessStartInfo]::new([string]$case.file)
foreach ($a in $case.args) { $psi.ArgumentList.Add([string]$a) }
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = [System.Diagnostics.Process]::Start($psi)
try {
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    $killed = $false
    if (-not $p.WaitForExit([int]$case.timeoutMs)) {
        $killed = [QuickChrLab.ProcessControl]::TerminateProcess($p.SafeHandle, 1)
        if (-not $killed) {
            $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastPInvokeError()
            if (-not $p.HasExited) {
                throw [System.ComponentModel.Win32Exception]::new($errorCode)
            }
        }
    }
    $p.WaitForExit()
    $sw.Stop()
    [PSCustomObject]@{
        killedAtDeadline = $killed
        exitCode         = $p.ExitCode
        ms               = $sw.ElapsedMilliseconds
        output           = "$($out.Result)$($err.Result)"
    } | ConvertTo-Json -Compress
} finally {
    $p.Dispose()
}

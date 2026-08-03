# version-matrix (CLI, Windows) - boot one CHR per channel in parallel, then list.
# PowerShell mirror of version-matrix.sh (parallel start via background jobs).
param([switch]$Lite)

$ErrorActionPreference = 'Stop'  # before the dot-source - see common.ps1 (#102)
. "$PSScriptRoot/../common.ps1"

$channels = if ($Lite) { @('long-term', 'stable') } else { @('long-term', 'stable', 'testing', 'development') }
$qc = $script:Quickchr

$jobs = @()
$i = 0
foreach ($ch in $channels) {
	$name = "examples-vm-$($ch -replace '-', '')-$PID"
	Register-Cleanup $name
	$base = 9200 + $i * 10
	Write-Host "-> starting $name (channel=$ch, port-base=$base)..."
	# $using: captures each iteration's loop values at Start-Job time (Start-Job
	# serializes them into the child runspace). This is the form PSScriptAnalyzer's
	# PSUseUsingScopeModifierInNewRunspaces wants -- it doesn't recognize the older
	# param()+-ArgumentList pattern and flags those as missing the Using: scope.
	$jobs += Start-Job -ScriptBlock {
		# Set INSIDE the block: Start-Job runs in a separate process that inherits
		# no preference variables, so the caller's and common.ps1's copies do not
		# reach here. Without these, a `quickchr start` that exits non-zero without
		# writing to stderr is invisible - Receive-Job returns, the script continues,
		# and the example exits 0 having booted nothing. Measured (pwsh 7.4.6): a
		# silent `exit 3` in a job gives rc=0 unset, rc=1 with these two set.
		$ErrorActionPreference = 'Stop'
		$PSNativeCommandUseErrorActionPreference = $true
		$parts = $using:qc -split '\s+'
		& $parts[0] @($parts[1..($parts.Length - 1)]) start $using:name --channel $using:ch --no-secure-login --port-base $using:base --add-package container --mem 256
	}
	$i++
}

try {
	$jobs | Wait-Job | Receive-Job
	Write-Host ""
	Invoke-Qc list
}
finally {
	$jobs | Remove-Job -Force -ErrorAction SilentlyContinue
	Invoke-QcCleanup
}

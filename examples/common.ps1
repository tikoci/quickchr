# Shared helpers for quickchr CLI examples (PowerShell - the Windows mirror of common.sh).
#
# Dot-source at the top of <name>.ps1, then wrap the body in try/finally:
#   . "$PSScriptRoot/../common.ps1"
#   $name = Get-ExampleName 'quickstart'; Register-Cleanup $name
#   try { Invoke-Qc start $name --channel stable; ... } finally { Invoke-QcCleanup }
#
# Resolution rule mirrors common.sh: prefer an explicit $env:QUICKCHR override,
# else the repo source CLI (so CI/local runs exercise THIS checkout), else a
# globally installed `quickchr`.

$ErrorActionPreference = 'Stop'
# Turn a non-zero exit from a native command (quickchr/bun) into a terminating
# error so a failed `start` stops the example instead of running the body anyway.
# (PowerShell 7.3+ honours this; on older hosts Invoke-Qc's $LASTEXITCODE check
# below is the backstop.)
$PSNativeCommandUseErrorActionPreference = $true

if ($env:QUICKCHR) {
	$script:Quickchr = $env:QUICKCHR
}
else {
	$repoCli = Join-Path $PSScriptRoot '../src/cli/index.ts'
	if ((Test-Path $repoCli) -and (Get-Command bun -ErrorAction SilentlyContinue)) {
		$script:Quickchr = "bun run $repoCli"
	}
	else {
		$script:Quickchr = 'quickchr'
	}
}

function Invoke-Qc {
	param([Parameter(ValueFromRemainingArguments = $true)] $Rest)
	$parts = $script:Quickchr -split '\s+'
	$exe = $parts[0]
	$pre = if ($parts.Length -gt 1) { $parts[1..($parts.Length - 1)] } else { @() }
	& $exe @($pre + $Rest)
	if ($LASTEXITCODE -ne 0) {
		throw "quickchr exited with code $LASTEXITCODE: $($Rest -join ' ')"
	}
}

function Get-ExampleName {
	param([Parameter(Mandatory = $true)][string] $Slug)
	$unique = '{0:x}{1:x}' -f $PID, (Get-Random -Maximum 65536)
	"examples-$Slug-$unique"
}

function Get-FreePort {
	$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
	$listener.Start()
	$port = $listener.LocalEndpoint.Port
	$listener.Stop()
	$port
}

$script:QcCleanup = [System.Collections.Generic.List[string]]::new()

function Register-Cleanup {
	param([Parameter(Mandatory = $true)][string] $Name)
	$script:QcCleanup.Add($Name)
}

function Invoke-QcCleanup {
	foreach ($name in $script:QcCleanup) {
		# Best-effort teardown: a remove failure (already gone) must not mask the
		# example's own error, so log at verbose level rather than rethrowing.
		try { Invoke-Qc remove $name *> $null }
		catch { Write-Verbose "cleanup: remove $name failed: $_" }
	}
}

# Backstop for a normal exit; examples should still use try/finally so Ctrl-C
# and mid-script errors reap the machine too.
Register-EngineEvent -SourceIdentifier ([System.Management.Automation.PsEngineEvent]::Exiting) `
	-Action { Invoke-QcCleanup } | Out-Null

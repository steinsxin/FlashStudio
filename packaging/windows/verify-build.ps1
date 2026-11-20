param([Parameter(Mandatory = $true)][string]$Executable)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Build-time inspection belongs on the MSVC builder, so install verification
# can also run on a clean Windows machine with no developer tools.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$dumpbin = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' | Select-Object -First 1
if (-not $dumpbin) { throw 'Cannot locate dumpbin for executable dependency check.' }
$imports = (& $dumpbin /dependents (Resolve-Path $Executable).Path) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect executable imports.' }
if ($imports -match '(?im)^\s*(?:VCRUNTIME|MSVCP)\d\S*\.dll') { throw 'Application unexpectedly requires a separate Visual C++ runtime.' }
Write-Host 'Verified application does not require a separate Visual C++ runtime.'

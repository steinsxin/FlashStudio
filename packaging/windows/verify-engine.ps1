param([Parameter(Mandatory = $true)][string]$EngineRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path $EngineRoot).Path.TrimEnd('\')
if (-not (Test-Path (Join-Path $root 'bin/openocd.exe.manifest'))) { throw 'Windows UTF-8 engine manifest missing.' }
$lock = Get-Content (Join-Path $PSScriptRoot '../openocd.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.platform -ne 'win32-x64' -or $manifest.version -ne $lock.version -or $manifest.archiveSha256 -ne $lock.platforms.'win32-x64'.sha256) {
    throw 'Missing, modified or wrong-platform engine.'
}
$inventory = @{}
foreach ($entry in $manifest.files.PSObject.Properties) { $inventory[$entry.Name] = $entry.Value }
$files = @(Get-ChildItem -LiteralPath $root -File -Recurse -Force | Where-Object { $_.FullName -ne (Join-Path $root 'manifest.json') })
if ($files.Count -ne $inventory.Count) { throw 'Engine inventory does not match installed files.' }
foreach ($file in $files) {
    $relative = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
    if (-not $inventory.ContainsKey($relative) -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne $inventory[$relative]) {
        throw "Missing or modified engine file: $relative"
    }
}
# Include non-ASCII text so a missing/ignored UTF-8 process manifest cannot
# pass merely because all OpenOCD status messages happen to be ASCII.
$marker = 'BUNDLED_ENGINE_READY_' + [char]0x4E2D + [char]0x6587
foreach ($adapter in @('stlink', 'jlink', 'cmsis-dap')) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $root 'bin/openocd.exe'
    $scripts = Join-Path $root 'openocd/scripts'
    $info.Arguments = "-s `"$scripts`" -f interface/$adapter.cfg -c `"transport select swd`" -f target/stm32f4x.cfg -c `"echo $marker; shutdown`""
    $info.WorkingDirectory = [IO.Path]::GetTempPath()
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $info.EnvironmentVariables['PATH'] = ''
    $info.EnvironmentVariables.Remove('OPENOCD_SCRIPTS')
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            $process.Kill()
            throw "Engine configuration timed out: $adapter"
        }
        $output = $stdout.Result + $stderr.Result
        if ($process.ExitCode -ne 0 -or -not $output.Contains($marker)) { throw "${adapter}: $output" }
    } finally { $process.Dispose() }
}
Write-Host 'Verified installed engine, full inventory, UTF-8 and all three adapters with an empty PATH.'

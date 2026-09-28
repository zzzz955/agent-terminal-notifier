function Save-InstalledVsix([string]$Destination) {
    $locations = & code.cmd --locate-extension 'local-tools.agent-terminal-notifier' 2>$null
    $location = $locations | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
    if (-not $location) { return $false }
    $package = Get-Content -LiteralPath (Join-Path $location 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($package.publisher -ne 'local-tools' -or $package.name -ne 'agent-terminal-notifier') { throw 'Unexpected installed extension identity.' }
    $content = Join-Path (Split-Path $Destination -Parent) 'previous-vsix-content'
    New-Item -ItemType Directory -Path $content -Force | Out-Null
    Copy-Item -LiteralPath $location -Destination (Join-Path $content 'extension') -Recurse
    $xml = [Xml.XmlDocument]::new()
    $xml.LoadXml('<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US"/><DisplayName/><Description/><Properties><Property Id="Microsoft.VisualStudio.Code.Engine"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>')
    $identity = $xml.SelectSingleNode('//*[local-name()="Identity"]')
    $identity.SetAttribute('Id', $package.name)
    $identity.SetAttribute('Version', $package.version)
    $identity.SetAttribute('Publisher', $package.publisher)
    $xml.SelectSingleNode('//*[local-name()="DisplayName"]').InnerText = $package.displayName
    $xml.SelectSingleNode('//*[local-name()="Description"]').InnerText = $package.description
    $xml.SelectSingleNode('//*[local-name()="Property"]').SetAttribute('Value', $package.engines.vscode)
    $xml.Save((Join-Path $content 'extension.vsixmanifest'))
    [IO.File]::WriteAllText((Join-Path $content '[Content_Types].xml'), '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($content, $Destination)
    return $true
}

function Move-InstallDirectory([string]$Source, [string]$Destination, [string]$InstallRoot) {
    $allowed = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
    foreach ($target in @($Source, $Destination)) {
        if (-not [IO.Path]::GetFullPath($target).StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Install move escaped its root.' }
    }
    Move-Item -LiteralPath $Source -Destination $Destination
}

function Restore-ConfigBackup([string]$Directory) {
    $file = Join-Path $Directory 'manifest.json'
    if (-not (Test-Path -LiteralPath $file)) { return }
    foreach ($entry in (Get-Content -LiteralPath $file -Encoding UTF8 -Raw | ConvertFrom-Json)) {
        if ($entry.existed) { Copy-Item -LiteralPath $entry.backup -Destination $entry.file -Force }
        elseif (Test-Path -LiteralPath $entry.file) { Remove-Item -LiteralPath $entry.file -Force }
    }
}

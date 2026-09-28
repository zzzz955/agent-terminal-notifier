# Match native UTF-8 output decoding and PowerShell-to-native pipe encoding.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

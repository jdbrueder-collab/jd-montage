# Hinterlegt den Lexware-Office-Schlüssel für die Montage-App, ohne dass er sichtbar wird oder im Verlauf landet.
# Schlüssel erstellen: Lexware Office → Einstellungen → Erweiterungen → Public API → „Neuen Schlüssel erstellen“.
Set-Location $PSScriptRoot
$sicher = Read-Host "Lexware-Schlüssel einfügen (Strg+V, wird nicht angezeigt) und Enter drücken" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sicher)
try {
  $k = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
  if ($k.Length -lt 20) { Write-Host "✗ Das sieht nicht nach einem Lexware-Schlüssel aus. Bitte nochmal kopieren." -ForegroundColor Red; exit 1 }
  npx.cmd --yes supabase@3.2.0 secrets set "LEXWARE_API_KEY=$k" --remote=glxnvjpoipcienngybmj --yes
  if ($LASTEXITCODE -eq 0) { Write-Host "✓ Schlüssel hinterlegt. In der App unter Setup → Lexware Office auf „Verbindung prüfen“ tippen." -ForegroundColor Green }
  else { Write-Host "✗ Hat nicht geklappt – Meldung oben lesen." -ForegroundColor Red }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $k = $null
}

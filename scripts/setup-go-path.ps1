$goBin = 'C:\Program Files\Go\bin'
$cur = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($cur -notlike ('*' + $goBin + '*')) {
    [Environment]::SetEnvironmentVariable('Path', $cur + ';' + $goBin, 'User')
    Write-Host 'ADDED Go bin to user PATH'
} else {
    Write-Host 'ALREADY in user PATH'
}
Write-Host '---'
[Environment]::GetEnvironmentVariable('Path', 'User') -split ';'

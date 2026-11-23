#Requires -RunAsAdministrator
<#
.SYNOPSIS
  注册 Windows 任务计划:每天 10:45 运行 Merge-JRMaster.ps1
.DESCRIPTION
  - 任务名:FeishuJRMerge
  - 触发器:每天 10:45(用户登录后才运行,因为需要 COM/Excel)
  - 操作:powershell.exe -ExecutionPolicy Bypass -File <脚本路径>
  - 运行身份:当前用户
  使用:以管理员身份运行 PowerShell,cd 到脚本目录,执行 .\Register-JRTask.ps1
#>

$ScriptPath = Join-Path $PSScriptRoot 'Merge-JRMaster.ps1'
$TaskName   = 'FeishuJRMerge'
$RunTime    = '10:45'

if (-not (Test-Path $ScriptPath)) {
    Write-Error "找不到合并脚本:$ScriptPath"
    exit 1
}

# 解析时间
$parts = $RunTime.Split(':')
$hour = [int]$parts[0]
$minute = [int]$parts[1]

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`"" `
    -WorkingDirectory $PSScriptRoot

$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour $hour -Minute $minute -Second 0 -Millisecond 0)

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

# 当前用户登录后运行(必须登录态,Excel COM 需要交互桌面)
$Principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive

# 如果任务已存在,先注销
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description "飞书招聘需求自动快照:每日 10:45 合并 CSV 到主表 Excel"

Write-Host ""
Write-Host "✅ 任务 '$TaskName' 已注册成功。" -ForegroundColor Green
Write-Host "   触发时间:每天 $RunTime"
Write-Host "   脚本路径:$ScriptPath"
Write-Host ""
Write-Host "可通过以下命令立即试运行:"
Write-Host "   powershell -ExecutionPolicy Bypass -File `"$ScriptPath`""
Write-Host ""
Write-Host "如需注销任务:Unregister-ScheduledTask -TaskName $TaskName"

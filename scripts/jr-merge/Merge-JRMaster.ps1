#Requires -Version 5.1
<#
.SYNOPSIS
  飞书 JR CSV → 主表 Excel 合并脚本(每天由任务计划程序 10:45 触发)
.DESCRIPTION
  - 扫描 Downloads 目录下 jr_new_YYYYMMDD_HHmm.csv
  - 每个 CSV:通过独立 Excel COM 实例打开主表,UPSERT(按第 15 列 Req# 去重),
    已存在则更新自动列,新 JR 追加,MANUAL 列(第 13 列"招聘启动日期")若已有值绝不覆盖
  - 处理完的 CSV 移到 Archive\ 子目录
  - 日志写入 jr_merge.log
  - 绝不触碰用户已打开的其他 Excel 文件(用独立实例,进程隔离)
.NOTES
  作者:你  |  版本:1.0.0  |  路径:C:\Users\\you\Desktop\AI\总结\
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ============== 配置区(可按需改) ==============
$Workspace  = 'C:\Users\\you\Desktop\AI\总结'
$Template   = 'C:\Users\\you\Desktop\招聘进展表需求模版.xlsx'
$Master     = Join-Path $Workspace '招聘进展表_主表.xlsx'
$Downloads  = [Environment]::GetFolderPath('UserProfile') + '\Downloads'
$Archive    = Join-Path $Workspace 'Archive'
$LogFile    = Join-Path $Workspace 'jr_merge.log'
$CsvPattern = 'jr_new_*.csv'

# 15 列配置(位置 1-based)
$ID_COL         = 15   # 招聘需求编号 Req# (去重键)
$TOTAL_COLS     = 15
# 强保护列:不管 CSV 里有啥值,只要主表中该单元格非空就绝不覆盖。
#   13 = 招聘启动日期(TA 手填)
#   校准后,若确认 Feishu 没有某个 VERIFY 字段,把对应列号也加到这里(例如 @(13,4,9))。
$MANUAL_COLS    = @(13)

# UPSERT 模式说明:
#   - 对已存在行的非保护列:仅在 CSV 对应列有非空白值时才写入;
#     CSV 值空白/空白串 → 跳过,保留主表现有值。
#   - 这层保护 + MANUAL_COLS 强保护 共两层,确保 TA 手填的任何值都不会被回灌清空。

# 重试/等待
$LockRetryCount = 5
$LockRetrySleep = 3   # 秒
# =================================================

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] $Message"
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
}

function Ensure-Archive {
    if (-not (Test-Path -LiteralPath $Archive)) {
        New-Item -ItemType Directory -Path $Archive -Force | Out-Null
    }
}

function Ensure-Master {
    if (Test-Path -LiteralPath $Master) { return }
    if (-not (Test-Path -LiteralPath $Template)) {
        throw "模板文件不存在:$Template,请确认桌面有模板文件。"
    }
    Copy-Item -LiteralPath $Template -Destination $Master -Force
    Write-Log "首次运行:从模板创建主表 $Master"
}

function Get-UnprocessedCsvs {
    if (-not (Test-Path -LiteralPath $Downloads)) { return @() }
    Get-ChildItem -LiteralPath $Downloads -Filter $CsvPattern -File |
        Sort-Object Name
}

# CSV 解析(支持 UTF-8 BOM + 可能带引号/换行的简单 CSV)
# 为简化:本脚本假设导出的 CSV 不含单元格内部换行/引号嵌套复杂情况,但做了基本的引号处理。
function Import-Csv-JR {
    param([string]$Path)

    $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    # 去 BOM
    if ($content.Length -gt 0 -and [int][char]$content[0] -eq 0xFEFF) {
        $content = $content.Substring(1)
    }

    # 按 \r\n 或 \n 换行,但注意引号内换行(简易状态机)
    $rows = New-Object System.Collections.Generic.List[string]
    $sb = New-Object System.Text.StringBuilder
    $inQuote = $false
    for ($i = 0; $i -lt $content.Length; $i++) {
        $ch = $content[$i]
        $next = if ($i + 1 -lt $content.Length) { $content[$i + 1] } else { $null }
        if ($ch -eq '"') {
            if ($inQuote -and $next -eq '"') {
                [void]$sb.Append('"'); $i++
            } else {
                $inQuote = -not $inQuote
            }
        } elseif (($ch -eq "`r" -or $ch -eq "`n") -and -not $inQuote) {
            if ($ch -eq "`r" -and $next -eq "`n") { $i++ }
            $line = $sb.ToString()
            if ($line.Length -gt 0 -or $rows.Count -gt 0) { $rows.Add($line) }
            [void]$sb.Clear()
        } else {
            [void]$sb.Append($ch)
        }
    }
    $tail = $sb.ToString()
    if ($tail.Length -gt 0) { $rows.Add($tail) }

    if ($rows.Count -lt 2) { return @() }

    function Split-CsvLine {
        param([string]$Line)
        $cols = New-Object System.Collections.Generic.List[string]
        $sb = New-Object System.Text.StringBuilder
        $inQuote = $false
        for ($i = 0; $i -lt $Line.Length; $i++) {
            $ch = $Line[$i]
            $next = if ($i + 1 -lt $Line.Length) { $Line[$i + 1] } else { $null }
            if ($ch -eq '"') {
                if ($inQuote -and $next -eq '"') { [void]$sb.Append('"'); $i++ }
                else { $inQuote = -not $inQuote }
            } elseif ($ch -eq ',' -and -not $inQuote) {
                $cols.Add($sb.ToString()); [void]$sb.Clear()
            } else {
                [void]$sb.Append($ch)
            }
        }
        $cols.Add($sb.ToString())
        return ,$cols.ToArray()
    }

    $headerLine = $rows[0]
    $headerCols = Split-CsvLine $headerLine
    $data = @()
    for ($r = 1; $r -lt $rows.Count; $r++) {
        $line = $rows[$r]
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $cells = Split-CsvLine $line
        # 单元格数必须是 15
        if ($cells.Count -lt $TOTAL_COLS) {
            $arr = New-Object string[] $TOTAL_COLS
            for ($c = 0; $c -lt $TOTAL_COLS; $c++) {
                $arr[$c] = if ($c -lt $cells.Count) { $cells[$c] } else { '' }
            }
            $cells = $arr
        } elseif ($cells.Count -gt $TOTAL_COLS) {
            # 截断到 15 列
            $arr = New-Object string[] $TOTAL_COLS
            [Array]::Copy($cells, $arr, $TOTAL_COLS)
            $cells = $arr
        }
        $rowObj = [pscustomobject]@{}
        for ($c = 0; $c -lt $TOTAL_COLS; $c++) {
            $rowObj | Add-Member -NotePropertyName ("Col" + ($c+1)) -NotePropertyValue $cells[$c]
        }
        $data += $rowObj
    }
    return ,$data
}

function New-DedicatedExcelInstance {
    # 记录启动前所有存在的 Excel PID,只杀本次新增的实例
    $beforePids = @{}
    try {
      Get-Process excel -ErrorAction SilentlyContinue | ForEach-Object { $beforePids[$_.Id] = $true }
    } catch {}

    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AskToUpdateLinks = $false
    $excel.AlertBeforeOverwriting = $false

    # 找到新增的 excel 进程(就是我们的)
    $ourPid = 0
    try {
      Start-Sleep -Milliseconds 200
      $procs = Get-Process excel -ErrorAction SilentlyContinue | Where-Object { -not $beforePids.ContainsKey($_.Id) }
      if ($procs) { $ourPid = ($procs | Select-Object -First 1).Id }
    } catch {}
    $excel | Add-Member -NotePropertyName OwningPid -NotePropertyValue $ourPid -Force
    return $excel
}

function Release-Excel {
    param($Excel, $Workbook)
    $ourPid = 0
    try { if ($Excel -and $Excel.OwningPid) { $ourPid = $Excel.OwningPid } } catch {}
    try {
        if ($Workbook) {
            $Workbook.Close($false)
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($Workbook) | Out-Null
        }
    } catch {}
    try {
        if ($Excel) {
            $Excel.Quit()
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($Excel) | Out-Null
        }
    } catch {}
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()

    # 只按 PID 精确杀掉我们自己启动的那个实例(绝不碰用户的 Excel)
    Start-Sleep -Milliseconds 300
    if ($ourPid -gt 0) {
        try {
            $p = Get-Process -Id $ourPid -ErrorAction SilentlyContinue
            if ($p -and -not $p.HasExited) {
                # 二次保险:如果它有可见窗口标题,说明被用户看到了,不杀
                if ([string]::IsNullOrWhiteSpace($p.MainWindowTitle)) {
                    Stop-Process -Id $ourPid -Force -ErrorAction SilentlyContinue
                }
            }
        } catch {}
    }
}

function Open-WorkbookWithRetry {
    param($Excel, [string]$Path)
    for ($attempt = 1; $attempt -le $LockRetryCount; $attempt++) {
        try {
            $wb = $Excel.Workbooks.Open($Path, 0, $false)
            return $wb
        } catch {
            if ($attempt -eq $LockRetryCount) { throw }
            Write-Log "  文件被占用,第 ${attempt}/${LockRetryCount} 次重试,等待 ${LockRetrySleep}s..."
            Start-Sleep -Seconds $LockRetrySleep
        }
    }
}

function Merge-OneCsv {
    param([string]$CsvPath)

    $csvName = Split-Path $CsvPath -Leaf
    Write-Log "处理 $csvName"

    $rows = Import-Csv-JR -Path $CsvPath
    if (-not $rows -or $rows.Count -eq 0) {
        Write-Log "  CSV 无数据行,跳过"
        Move-ProcessedCsv -CsvPath $CsvPath -Reason 'empty'
        return
    }
    Write-Log "  CSV 解析完成,共 $($rows.Count) 行"

    $excel = $null
    $wb = $null
    try {
        $excel = New-DedicatedExcelInstance
        $wb = Open-WorkbookWithRetry -Excel $excel -Path $Master
        $ws = $wb.Worksheets.Item(1)

        # 1. 扫描主表现有行,建立 ID -> 行号 索引
        $usedRange = $ws.UsedRange
        $rowCount = $usedRange.Rows.Count
        $colCount = $usedRange.Columns.Count
        Write-Log "  主表现有 $rowCount 行,$colCount 列"

        $idMap = @{}   # id -> rowIndex(1-based,含表头的话数据从 2 开始)
        # 表头在第 1 行,数据从第 2 行开始
        $lastDataRow = 1
        for ($r = 2; $r -le $rowCount; $r++) {
            $idVal = $ws.Cells.Item($r, $ID_COL).Text
            if (-not [string]::IsNullOrWhiteSpace($idVal)) {
                $idKey = $idVal.Trim()
                if (-not $idMap.ContainsKey($idKey)) {
                    $idMap[$idKey] = $r
                }
                $lastDataRow = $r
            }
        }

        $added = 0; $updated = 0; $skipped = 0
        $nextRow = $lastDataRow + 1

        foreach ($row in $rows) {
            $id = $row.("Col${ID_COL}")
            if ([string]::IsNullOrWhiteSpace($id)) { $skipped++; continue }
            $id = $id.Trim()

            if ($idMap.ContainsKey($id)) {
                # UPSERT:已存在行 → 仅更新 CSV 中有值的非保护列,任何空白源值都不覆盖
                $targetRow = $idMap[$id]
                $cellsUpdatedThisRow = 0
                for ($c = 1; $c -le $TOTAL_COLS; $c++) {
                    $newVal = $row.("Col${c}")
                    if ($newVal -eq $null) { $newVal = '' }
                    $newVal = $newVal.ToString().Trim()

                    # 规则 1: 手填列(MANUAL_COLS)若已有值,永远不覆盖(即使 CSV 有值也跳过)
                    if ($MANUAL_COLS -contains $c) {
                        $existing = $ws.Cells.Item($targetRow, $c).Text
                        if (-not [string]::IsNullOrWhiteSpace($existing)) {
                            continue
                        }
                        # 手填列空白时,仍要检查 CSV 值是否为空
                        if ([string]::IsNullOrWhiteSpace($newVal)) {
                            continue
                        }
                        # 否则(空白 + CSV 有值)允许写入
                    }

                    # 规则 2: CSV 值空白 → 一律跳过,保留已有单元格(保护 TA 手填的任何列)
                    if ([string]::IsNullOrWhiteSpace($newVal)) {
                        continue
                    }

                    $ws.Cells.Item($targetRow, $c).Value2 = $newVal
                    $cellsUpdatedThisRow++
                }
                # 至少更新了一个单元格才算更新
                if ($cellsUpdatedThisRow -gt 0) { $updated++ } else { $skipped++ }
            } else {
                # 新 JR → 追加全部列(空白列也写,保持行结构一致)
                $targetRow = $nextRow
                for ($c = 1; $c -le $TOTAL_COLS; $c++) {
                    $newVal = $row.("Col${c}")
                    if ($newVal -eq $null) { $newVal = '' }
                    $ws.Cells.Item($targetRow, $c).Value2 = $newVal
                }
                $idMap[$id] = $targetRow
                $nextRow++
                $added++
            }
        }

        $wb.Save()
        Write-Log "  合并完成:新增 $added 行,更新 $updated 行,跳过 $skipped 行"

        Move-ProcessedCsv -CsvPath $CsvPath
    }
    finally {
        Release-Excel -Excel $excel -Workbook $wb
    }
}

function Move-ProcessedCsv {
    param([string]$CsvPath, [string]$Reason = 'done')
    Ensure-Archive
    $name = Split-Path $CsvPath -Leaf
    $ts = Get-Date -Format 'yyyyMMdd_HHmmss'
    $destName = if ($Reason -eq 'empty') { "$name.$ts.empty" } else { "$name" }
    $dest = Join-Path $Archive $destName
    Move-Item -LiteralPath $CsvPath -Destination $dest -Force
    Write-Log "  CSV 已归档 → $dest"
}

# ============ Main ============
try {
    Write-Log "========== 开始合并任务 =========="
    Ensure-Archive
    Ensure-Master

    $csvs = @(Get-UnprocessedCsvs)
    if ($csvs.Count -eq 0) {
        Write-Log "Downloads 中没有待处理的 $CsvPattern,无需合并"
        exit 0
    }
    Write-Log "发现 $($csvs.Count) 个待处理 CSV"

    foreach ($csv in $csvs) {
        try {
            Merge-OneCsv -CsvPath $csv.FullName
        } catch {
            Write-Log ("  处理失败:" + $_.Exception.Message)
        }
    }

    Write-Log "========== 任务结束 =========="
    exit 0
}
catch {
    Write-Log ("致命错误:" + $_.Exception.ToString())
    exit 1
}

# ClaudeManager autostart para Windows (Task Scheduler)
# Uso: Ejecutar como Administrador
#   .\scripts\autostart.ps1 install
#   .\scripts\autostart.ps1 uninstall
#   .\scripts\autostart.ps1 status

param([string]$Action = "install")

$TaskName   = "ClaudeManager"
$ProjectDir = (Resolve-Path "$PSScriptRoot\..").Path
$NodeBin    = (Get-Command node -ErrorAction SilentlyContinue)?.Source
$LogDir     = Join-Path $ProjectDir "logs"

if (-not $NodeBin) {
    Write-Error "Node.js no encontrado en el PATH. Instálalo desde https://nodejs.org"
    exit 1
}

switch ($Action) {
    "install" {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

        $action  = New-ScheduledTaskAction `
            -Execute $NodeBin `
            -Argument "server.js" `
            -WorkingDirectory $ProjectDir

        $trigger  = New-ScheduledTaskTrigger -AtLogon
        $settings = New-ScheduledTaskSettingsSet `
            -RestartCount 5 `
            -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero)

        Register-ScheduledTask `
            -TaskName $TaskName `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -RunLevel Highest `
            -Force | Out-Null

        # Arrancar ahora sin esperar al siguiente login
        Start-ScheduledTask -TaskName $TaskName

        Write-Host ""
        Write-Host "V ClaudeManager registrado en el Programador de tareas de Windows"
        Write-Host "  Proyecto : $ProjectDir"
        Write-Host "  Node     : $NodeBin"
        Write-Host "  Logs     : $LogDir"
        Write-Host ""
        Write-Host "  El servidor arrancara automaticamente en cada inicio de sesion."
        Write-Host "  Abre http://localhost:3000 en el navegador."
    }

    "uninstall" {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "V Autostart eliminado"
    }

    "status" {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            Write-Host "● ClaudeManager esta registrado — Estado: $($task.State)"
        } else {
            Write-Host "○ ClaudeManager NO esta registrado"
        }
    }

    default {
        Write-Host "Uso: .\scripts\autostart.ps1 [install|uninstall|status]"
        exit 1
    }
}

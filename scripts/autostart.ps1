# ClaudeManager autostart para Windows (registro HKCU - no requiere Administrador)
# Uso:
#   .\scripts\autostart.ps1 install
#   .\scripts\autostart.ps1 uninstall
#   .\scripts\autostart.ps1 status

param([string]$Action = "install")

$AppName    = "ClaudeManager"
$RegPath    = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
$ProjectDir = (Resolve-Path "$PSScriptRoot\..").Path
$ServerJs   = Join-Path $ProjectDir "server.js"
$NodeCmd    = Get-Command node -ErrorAction SilentlyContinue
$NodeBin    = if ($NodeCmd) { $NodeCmd.Source } else { $null }

if (-not $NodeBin) {
    Write-Error "Node.js no encontrado en el PATH. Instalalo desde https://nodejs.org"
    exit 1
}

# Wrapper VBScript para arrancar Node sin ventana de consola visible
$VbsPath = Join-Path $ProjectDir "scripts\start-hidden.vbs"

switch ($Action) {
    "install" {
        # Crear el VBScript que lanza node sin ventana visible
        $vbsContent = @"
Set oShell = CreateObject("WScript.Shell")
oShell.Run """$NodeBin"" ""$ServerJs""", 0, False
"@
        Set-Content -Path $VbsPath -Value $vbsContent -Encoding ASCII

        # Registrar en HKCU\Run para que arranque con el inicio de sesion
        $cmd = "wscript.exe `"$VbsPath`""
        Set-ItemProperty -Path $RegPath -Name $AppName -Value $cmd

        # Arrancar ahora mismo
        Start-Process "wscript.exe" -ArgumentList "`"$VbsPath`"" -WindowStyle Hidden

        Write-Host ""
        Write-Host "OK ClaudeManager registrado para iniciar con Windows"
        Write-Host "  Proyecto : $ProjectDir"
        Write-Host "  Node     : $NodeBin"
        Write-Host ""
        Write-Host "  El servidor arrancara automaticamente en cada inicio de sesion."
        Write-Host "  Abre http://localhost:3000 en el navegador."
    }

    "uninstall" {
        Remove-ItemProperty -Path $RegPath -Name $AppName -ErrorAction SilentlyContinue
        if (Test-Path $VbsPath) { Remove-Item $VbsPath -Force }
        # Matar el proceso node que sirve este proyecto si esta corriendo
        $procs = Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.CommandLine -like "*$ServerJs*") {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Host "OK Autostart eliminado"
    }

    "status" {
        $entry = (Get-ItemProperty -Path $RegPath -ErrorAction SilentlyContinue).$AppName
        if ($entry) {
            Write-Host "* ClaudeManager esta registrado en HKCU\Run"
            Write-Host "  $entry"
        } else {
            Write-Host "o ClaudeManager NO esta registrado"
        }
    }

    default {
        Write-Host "Uso: .\scripts\autostart.ps1 [install|uninstall|status]"
        exit 1
    }
}

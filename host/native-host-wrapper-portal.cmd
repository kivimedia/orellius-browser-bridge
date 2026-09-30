@echo off
rem PORTAL FORK of native-host-wrapper.cmd. The one difference: pins
rem ORELLIUS_HUB_PORT to the portal's own isolated hub (18787) before exec'ing
rem node, so native-host-portal.js's getPort() env-var check always wins -
rem never depends on which Windows user's ~/.config file happens to exist.
rem Points at native-host-portal.js, never native-host.js: the two must not
rem cross-wire, since this one registers under a different native-host name
rem and browser tag entirely (see background.js's NATIVE_HOST_NAME/BROWSER_ID
rem in extension-portal/).
set ORELLIUS_HUB_PORT=18787
"C:\Program Files\nodejs\node.exe" "%~dp0native-host-portal.js" %*

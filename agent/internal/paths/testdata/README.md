# Security descriptors for the ACL tests

Owner and DACL of standard Windows folders in SDDL, as
`ConvertSecurityDescriptorToStringSecurityDescriptorW` prints them (the agent
reads them the same way, `internal/winapi/advapi32_windows.go`).

The files were written from the documented default permissions (what `icacls`
shows on a fresh installation), not dumped from a machine. Replacing them with
real dumps from Windows 11 and Windows Server 2022 is a maintainer step on a
real machine (docs/WINDOWS-AGENT.md, section 22.3, item 1):

```powershell
(Get-Acl 'C:\').Sddl
(Get-Acl 'C:\ProgramData').Sddl
(Get-Acl 'C:\Program Files').Sddl
(Get-Acl 'C:\Windows\Temp').Sddl
```

`Get-Acl` adds the group and a SACL is left out; both are ignored by the parser.

| File | Folder |
| --- | --- |
| c-root.sddl | `C:\` |
| programdata.sddl | `C:\ProgramData` |
| programfiles.sddl | `C:\Program Files` |
| programfiles-restow-bin.sddl | `C:\Program Files\Restow\bin` (inherited, created by an administrator) |
| windows-temp.sddl | `C:\Windows\Temp` |
| protected.sddl | a folder with the agent's protected DACL |
| user-owned.sddl | a folder a user created and owns |
| users-modify.sddl | a folder where Users have Modify |

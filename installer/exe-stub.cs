using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Diagnostics;

// Version/identity metadata baked into the PE resource. An unsigned binary with
// NO product identity reads as anonymous/suspicious to reputation heuristics;
// declaring a real product, company and version is a cheap, honest signal.
[assembly: AssemblyTitle("IDevelop Installer")]
[assembly: AssemblyProduct("IDevelop")]
[assembly: AssemblyCompany("IDevelop")]
[assembly: AssemblyDescription("IDevelop on-premise installer and maintenance launcher")]
[assembly: AssemblyCopyright("Copyright IDevelop")]
[assembly: AssemblyVersion("3.22.25.0")]
[assembly: AssemblyFileVersion("3.22.25.0")]

// Self-extracting bootstrap for the IDevelop installer. The full installer
// package is embedded as the resource "package.zip". The bundled app.manifest
// declares requireAdministrator, so Windows shows the UAC prompt up front and
// the process is ALREADY elevated here — we do NOT spawn PowerShell to
// re-elevate (that self-elevation chain is a classic "defense evasion" signal
// for behavior-based AV). We stage under %ProgramData% (a legitimate install
// location) rather than %TEMP% (a dropper hallmark), then launch Setup.bat,
// whose own elevation step is a no-op because we are already admin.
class Program {
    static int Main() {
        try {
            Console.Title = "IDevelop Installer";

            // Prefer %ProgramData%\IDevelop\installer; fall back to %TEMP% only
            // if that isn't writable (should not happen once elevated).
            string baseDir;
            try {
                baseDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                    "IDevelop", "installer");
            } catch { baseDir = Path.Combine(Path.GetTempPath(), "IDevelop-Installer"); }

            Console.WriteLine();
            Console.WriteLine("  Preparing the IDevelop installer...");
            Console.WriteLine("  (staging to " + baseDir + ")");

            try { if (Directory.Exists(baseDir)) Directory.Delete(baseDir, true); } catch { }
            Directory.CreateDirectory(baseDir);

            string zp = Path.Combine(baseDir, "package.zip");
            var asm = Assembly.GetExecutingAssembly();
            using (var s = asm.GetManifestResourceStream("package.zip")) {
                if (s == null) { Console.WriteLine("  ERROR: embedded package missing."); Console.ReadLine(); return 1; }
                using (var fs = File.Create(zp)) { s.CopyTo(fs); }
            }
            ZipFile.ExtractToDirectory(zp, baseDir);
            try { File.Delete(zp); } catch { }

            // Prefer the wizard (Welcome / Licence / Progress / Finish) - that is
            // what a person double-clicking a Setup.exe expects on Windows. The
            // text menu (Setup.bat) remains the fallback and still ships for the
            // advanced operations: backup, restore, restore points, checks.
            string setup = null;
            foreach (var name in new[] { "Setup-Wizard.bat", "Setup.bat" }) {
                foreach (var f in Directory.GetFiles(baseDir, name, SearchOption.AllDirectories)) { setup = f; break; }
                if (setup != null) break;
            }
            if (setup == null) { Console.WriteLine("  ERROR: no setup launcher found after extraction."); Console.ReadLine(); return 1; }

            // Launch the menu directly in this (already-elevated) console. No
            // PowerShell relaunch, no "-Verb RunAs" — the manifest handled UAC.
            var psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + setup + "\"\"") {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(setup),
            };
            var p = Process.Start(psi);
            p.WaitForExit();
            return p.ExitCode;
        } catch (Exception ex) {
            Console.WriteLine("  Installer bootstrap error: " + ex.Message);
            Console.ReadLine();
            return 1;
        }
    }
}

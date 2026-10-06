
using System;
using System.Windows.Forms;

class Program {
    [STAThread]
    static void Main() {
        try {
            if (Clipboard.ContainsFileDropList()) {
                var files = Clipboard.GetFileDropList();
                foreach (string f in files) {
                    Console.WriteLine(f);
                }
            }
        } catch {}
    }
}

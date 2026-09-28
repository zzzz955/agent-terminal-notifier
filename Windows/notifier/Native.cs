using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AgentTerminalNotifier;

internal static class Native
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size, Usage, Pid;
        public IntPtr Heap;
        public uint Module, Threads, ParentPid;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo { public uint Size; public IntPtr Hwnd; public uint Flags, Count, Timeout; }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool FlashWindowEx(ref FlashInfo info);

    internal static List<int> Ancestors(int pid)
    {
        var parents = new Dictionary<int, int>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("Process snapshot failed");
        try
        {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), Exe = "" };
            if (Process32FirstW(snapshot, ref entry))
                do { parents[(int)entry.Pid] = (int)entry.ParentPid; } while (Process32NextW(snapshot, ref entry));
        }
        finally { CloseHandle(snapshot); }
        var result = new List<int>();
        while (pid > 0 && !result.Contains(pid) && result.Count < 64)
        {
            result.Add(pid);
            if (!parents.TryGetValue(pid, out pid)) break;
        }
        return result;
    }

    internal static uint WindowPid(IntPtr hwnd) { GetWindowThreadProcessId(hwnd, out uint pid); return pid; }
    internal static bool ValidWindow(IntPtr hwnd, uint pid)
    {
        if (hwnd == IntPtr.Zero || pid == 0 || !IsWindow(hwnd) || WindowPid(hwnd) != pid) return false;
        try { using var process = Process.GetProcessById((int)pid); return process.ProcessName is "Code" or "Code - Insiders"; }
        catch (ArgumentException) { return false; }
    }
    internal static IntPtr CaptureWindow(int extensionPid)
    {
        IntPtr hwnd = GetForegroundWindow();
        uint pid = WindowPid(hwnd);
        return ValidWindow(hwnd, pid) && Ancestors(extensionPid).Contains((int)pid) ? hwnd : IntPtr.Zero;
    }
    internal static void Restore(IntPtr hwnd)
    {
        ShowWindow(hwnd, 9); // SW_RESTORE
        if (!SetForegroundWindow(hwnd)) throw new InvalidOperationException("Windows denied foreground activation");
    }
    internal static void Flash(IntPtr hwnd)
    {
        var info = new FlashInfo { Size = (uint)Marshal.SizeOf<FlashInfo>(), Hwnd = hwnd, Flags = 2, Count = 5, Timeout = 0 };
        FlashWindowEx(ref info);
    }
}

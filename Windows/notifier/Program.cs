using System.Diagnostics;
using System.IO.Pipes;
using System.Media;
using System.Text;
using System.Text.Json;
using System.Xml;
using Microsoft.Toolkit.Uwp.Notifications;
using Microsoft.Win32;
using Windows.UI.Notifications;

namespace AgentTerminalNotifier;

internal static class Program
{
    internal static readonly string Root = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentTerminalNotifier");
    internal const string Scheme = "agent-terminal-notifier";
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };

    [STAThread]
    private static int Main(string[] args)
    {
        bool hook = args.FirstOrDefault() is "send" or "fanout" && !args.Contains("--strict");
        try
        {
            switch (args.FirstOrDefault())
            {
                case "register": Register(); break;
                case "unregister": Unregister(); break;
                case "send": Send(args); break;
                case "fanout": Fanout(args); break;
                case "show": Show(JsonSerializer.Deserialize<Alert>(ReadInput(), Json) ?? throw new InvalidDataException("Missing alert")); break;
                case "focus": Focus(args.ElementAtOrDefault(1) ?? ""); break;
                case "window":
                    var handle = Native.CaptureWindow(int.Parse(args[1]));
                    Console.WriteLine(JsonSerializer.Serialize(new { hwnd = handle.ToInt64().ToString(), pid = Native.WindowPid(handle) }, Json));
                    break;
                case "self-test": SelfTest(); break;
                default: throw new ArgumentException("Commands: register, unregister, send SOURCE EVENT [JSON] [--strict], focus URI, window PID, self-test");
            }
            return 0;
        }
        catch (Exception ex)
        {
            // Hook errors must never stop the agent. Do not log input, URIs or capabilities.
            Directory.CreateDirectory(Root);
            File.AppendAllText(Path.Combine(Root, "errors.log"), $"{DateTimeOffset.Now:O} {args.FirstOrDefault()}: {ex.GetType().Name}\n");
            if (!hook) Console.Error.WriteLine(ex.Message);
            if (args.FirstOrDefault() == "focus")
                MessageBox.Show("해당 터미널 또는 VSCode 창이 종료되었거나 연결을 찾을 수 없습니다.\nVSCode에서 Agent Notifier: Show Registered Terminals를 확인하세요.", "Agent Terminal Notifier");
            return hook ? 0 : 1;
        }
    }

    private static void Register()
    {
        string exe = Environment.ProcessPath ?? throw new InvalidOperationException("Executable path unavailable");
        using var existing = Registry.CurrentUser.OpenSubKey($"Software\\Classes\\{Scheme}\\shell\\open\\command");
        string command = $"\"{exe}\" focus \"%1\"";
        if (existing?.GetValue("") is string old && old != command)
            throw new InvalidOperationException("The notification protocol is already registered to another installation.");
        using var key = Registry.CurrentUser.CreateSubKey($"Software\\Classes\\{Scheme}");
        key.SetValue("", "URL:Agent Terminal Notifier");
        key.SetValue("URL Protocol", "");
        using var open = key.CreateSubKey("shell\\open\\command");
        open.SetValue("", command);
        // The toolkit registers the unpackaged app's notification identity for this user.
        _ = ToastNotificationManagerCompat.CreateToastNotifier();
    }

    private static void Unregister()
    {
        using var key = Registry.CurrentUser.OpenSubKey($"Software\\Classes\\{Scheme}\\shell\\open\\command");
        string expected = $"\"{Environment.ProcessPath}\" focus \"%1\"";
        if (key?.GetValue("") as string == expected)
            Registry.CurrentUser.DeleteSubKeyTree($"Software\\Classes\\{Scheme}", false);
        ToastNotificationManagerCompat.Uninstall();
    }

    internal static string? NormalizeEvent(string requested, JsonElement input)
    {
        if (requested != "auto")
            return new[] { "completed", "attention", "blocked", "error" }.Contains(requested) ? requested : throw new ArgumentException("Unknown event");
        return Get(input, "hook_event_name") switch
        {
            "Stop" => "completed",
            "StopFailure" => "error",
            "Notification" => Get(input, "notification_type") is "permission_prompt" or "elicitation_dialog" or "agent_needs_input" or "worker_permission_prompt" ? "attention" : null,
            _ => null
        };
    }

    internal static string Get(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString()! : "";

    private static string ReadInput()
    {
        using var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static void Fanout(string[] args)
    {
        string[] original = JsonSerializer.Deserialize<string[]>(args[1]) ?? throw new InvalidDataException("Missing original notify command");
        string payload = args[2];
        if (original.Length == 0 || string.IsNullOrWhiteSpace(original[0])) throw new InvalidDataException("Invalid original notify command");
        // Preserve the exact executable/argv; never interpolate commands into a shell.
        var start = new ProcessStartInfo(original[0]) { UseShellExecute = false, CreateNoWindow = true };
        foreach (string argument in original.Skip(1)) start.ArgumentList.Add(argument);
        start.ArgumentList.Add(payload);
        try { using var process = Process.Start(start); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Directory.CreateDirectory(Root);
            File.AppendAllText(Path.Combine(Root, "errors.log"), $"{DateTimeOffset.Now:O} original-notify: {ex.GetType().Name}\n");
        }
        Send(["send", "codex", "completed", payload]);
    }

    private static void Send(string[] args)
    {
        string source = args.ElementAtOrDefault(1) ?? "hook";
        if (!new[] { "codex", "claude", "hook", "test" }.Contains(source)) throw new ArgumentException("Unknown source");
        string requested = args.ElementAtOrDefault(2) ?? "blocked";
        string raw = args.ElementAtOrDefault(3)?.StartsWith('{') == true ? args[3] : Console.IsInputRedirected ? ReadInput() : "{}";
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(raw) ? "{}" : raw);
        string? ev = NormalizeEvent(requested, doc.RootElement);
        if (ev == null) return;
        var ancestors = Native.Ancestors(Environment.ProcessId);
        string directory = Path.Combine(Root, "routes");
        var candidates = new List<(Route route, TerminalRoute terminal, int distance)>();
        foreach (string file in Directory.Exists(directory) ? Directory.GetFiles(directory, "*.json") : [])
        {
            try
            {
                var route = JsonSerializer.Deserialize<Route>(File.ReadAllText(file), Json);
                if (route == null || !ValidPipe(route.Pipe) || route.Token.Length != 64) continue;
                foreach (var terminal in route.Terminals)
                {
                    int distance = ancestors.IndexOf(terminal.Pid);
                    if (distance >= 0) candidates.Add((route, terminal, distance));
                }
            }
            catch (IOException) { /* A window may close while reading its registration. */ }
            catch (JsonException) { }
        }
        foreach (var candidate in candidates.OrderBy(c => c.distance))
        {
            var message = new
            {
                action = "notify", token = candidate.route.Token, sessionId = candidate.terminal.SessionId, source, @event = ev,
                eventId = Get(doc.RootElement, "turn-id") is string id && id.Length > 0 ? id : Get(doc.RootElement, "turn_id"),
                cwd = Get(doc.RootElement, "cwd") is string cwd && cwd.Length > 0 ? cwd : Environment.CurrentDirectory
            };
            try
            {
                using var response = Call(candidate.route.Pipe, message);
                if (response.RootElement.GetProperty("ok").GetBoolean()) return;
            }
            catch (IOException) { }
            catch (TimeoutException) { }
            catch (OperationCanceledException) { }
        }
        throw new InvalidOperationException("No registered VSCode terminal in this process ancestry. Open a local integrated terminal and check extension status.");
    }

    internal static bool ValidPipe(string pipe) => pipe.StartsWith("agent-notifier-", StringComparison.Ordinal) && Guid.TryParseExact(pipe[15..], "D", out _);

    internal static JsonDocument Call(string pipe, object message)
    {
        if (!ValidPipe(pipe)) throw new InvalidDataException("Invalid pipe");
        using var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        client.ConnectAsync(timeout.Token).GetAwaiter().GetResult();
        using var writer = new StreamWriter(client, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
        using var reader = new StreamReader(client, Encoding.UTF8, leaveOpen: true);
        writer.WriteLineAsync(JsonSerializer.Serialize(message, Json).AsMemory(), timeout.Token).GetAwaiter().GetResult();
        string? line = reader.ReadLineAsync(timeout.Token).AsTask().GetAwaiter().GetResult();
        if (line == null || line.Length > 16384) throw new InvalidDataException("Invalid reply");
        return JsonDocument.Parse(line);
    }

    internal static Uri FocusUri(Alert alert) => new($"{Scheme}://focus/?pipe={Uri.EscapeDataString(alert.Pipe)}&token={Uri.EscapeDataString(alert.Token)}&session={Uri.EscapeDataString(alert.SessionId)}");

    private static void Focus(string raw)
    {
        var uri = new Uri(raw);
        if (uri.Scheme != Scheme || uri.Host != "focus" || raw.Length > 1024) throw new InvalidDataException("Invalid activation URI");
        var query = uri.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).ToDictionary(p => p[0], p => Uri.UnescapeDataString(p.ElementAtOrDefault(1) ?? ""));
        if (!query.TryGetValue("pipe", out string? pipe) || !ValidPipe(pipe) || !query.TryGetValue("token", out string? token) || token.Length != 64 || !query.TryGetValue("session", out string? session) || !Guid.TryParse(session, out _))
            throw new InvalidDataException("Invalid activation data");
        using var reply = Call(pipe, new { action = "focus", token, sessionId = session });
        if (!reply.RootElement.GetProperty("ok").GetBoolean()) throw new InvalidOperationException("Terminal closed");
        var hwnd = new IntPtr(long.Parse(reply.RootElement.GetProperty("hwnd").GetString()!));
        uint pid = reply.RootElement.GetProperty("hwndPid").GetUInt32();
        if (!Native.ValidWindow(hwnd, pid)) throw new InvalidOperationException("VSCode window unavailable");
        Native.Restore(hwnd);
    }

    internal static string ToastXml(Alert alert)
    {
        using var text = new StringWriter();
        using (var xml = XmlWriter.Create(text, new XmlWriterSettings { OmitXmlDeclaration = true }))
        {
            xml.WriteStartElement("toast");
            xml.WriteAttributeString("activationType", "protocol");
            xml.WriteAttributeString("launch", FocusUri(alert).AbsoluteUri);
            xml.WriteStartElement("visual"); xml.WriteStartElement("binding"); xml.WriteAttributeString("template", "ToastGeneric");
            xml.WriteElementString("text", alert.Title);
            xml.WriteElementString("text", alert.Event switch { "completed" => "응답 완료 · 클릭하여 터미널로 이동", "attention" => "승인 또는 입력 필요 · 클릭하여 이동", "blocked" => "훅 차단 · 클릭하여 확인", _ => "오류 발생 · 클릭하여 확인" });
            xml.WriteEndElement(); xml.WriteEndElement();
            xml.WriteStartElement("audio"); xml.WriteAttributeString("silent", "true"); xml.WriteEndElement();
            xml.WriteEndElement();
        }
        return text.ToString();
    }

    private static void Show(Alert alert)
    {
        if (!ValidPipe(alert.Pipe) || alert.Token.Length != 64 || !Guid.TryParse(alert.SessionId, out _) || !new[] { "completed", "attention", "blocked", "error" }.Contains(alert.Event)) throw new InvalidDataException("Invalid alert");
        var xml = new Windows.Data.Xml.Dom.XmlDocument(); xml.LoadXml(ToastXml(alert));
        var toast = new ToastNotification(xml) { ExpirationTime = DateTimeOffset.Now.AddHours(8), Group = "agents", Tag = alert.SessionId[..16] };
        ToastNotificationManagerCompat.CreateToastNotifier().Show(toast);
        var hwnd = new IntPtr(long.Parse(alert.Hwnd));
        if (alert.Flash && Native.ValidWindow(hwnd, alert.HwndPid)) Native.Flash(hwnd);
        if (alert.Sound)
        {
            string wav = Path.Combine(alert.SoundDirectory, alert.Event + ".wav");
            try { using var player = new SoundPlayer(wav); player.PlaySync(); }
            catch (Exception ex) when (ex is IOException or InvalidOperationException or TimeoutException) { SystemSounds.Exclamation.Play(); }
        }
    }

    private static void SelfTest()
    {
        static void Check(bool pass, string name) { if (!pass) throw new Exception("Self-test failed: " + name); }
        using var idle = JsonDocument.Parse("{\"hook_event_name\":\"Notification\",\"notification_type\":\"idle_prompt\"}");
        using var permission = JsonDocument.Parse("{\"hook_event_name\":\"Notification\",\"notification_type\":\"permission_prompt\"}");
        Check(NormalizeEvent("auto", idle.RootElement) == null, "idle filtering");
        Check(NormalizeEvent("auto", permission.RootElement) == "attention", "permission mapping");
        Check(NormalizeEvent("blocked", idle.RootElement) == "blocked", "explicit blocked");
        var alert = new Alert { Pipe = "agent-notifier-" + Guid.NewGuid(), Token = new string('a', 64), SessionId = Guid.NewGuid().ToString(), Title = "한글 & <project> \"test\"", Event = "completed" };
        Check(ValidPipe(alert.Pipe) && !ValidPipe("agent-notifier-../../other"), "pipe validation");
        var doc = new System.Xml.XmlDocument(); doc.LoadXml(ToastXml(alert));
        Check(doc.SelectSingleNode("//text")!.InnerText == alert.Title, "toast escaping");
        Check(doc.DocumentElement!.GetAttribute("launch") == FocusUri(alert).AbsoluteUri, "click activation");
        Check(Native.Ancestors(Environment.ProcessId).Count >= 2, "native process ancestry");
        Console.WriteLine("Notifier self-tests passed (6 checks; no settings changed).");
    }
}

internal sealed class Route
{
    public string Pipe { get; set; } = "";
    public string Token { get; set; } = "";
    public List<TerminalRoute> Terminals { get; set; } = [];
}
internal sealed class TerminalRoute
{
    public string SessionId { get; set; } = "";
    public int Pid { get; set; }
}
internal sealed class Alert
{
    public string Pipe { get; set; } = "";
    public string Token { get; set; } = "";
    public string SessionId { get; set; } = "";
    public string Title { get; set; } = "";
    public string Event { get; set; } = "completed";
    public string Hwnd { get; set; } = "0";
    public uint HwndPid { get; set; }
    public bool Sound { get; set; }
    public bool Flash { get; set; }
    public string SoundDirectory { get; set; } = "";
}

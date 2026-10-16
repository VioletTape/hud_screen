using System.IO.Pipes;
using System.Text.Json;

namespace ControlPanel.Hud;

internal sealed class SingleInstance(string name) : IDisposable
{
  private readonly CancellationTokenSource cancellation = new();
  private Task? listener;

  public static void Send(string name, LaunchOptions options)
  {
    using var pipe = new NamedPipeClientStream(".", name, PipeDirection.Out, PipeOptions.CurrentUserOnly);
    pipe.Connect(10000);
    using var writer = new StreamWriter(pipe);
    writer.WriteLine(JsonSerializer.Serialize(options));
  }

  public void Start(Action<LaunchOptions> onLaunch)
  {
    listener = ListenAsync(onLaunch);
  }

  private async Task ListenAsync(Action<LaunchOptions> onLaunch)
  {
    while (!cancellation.IsCancellationRequested)
    {
      try
      {
        using var pipe = new NamedPipeServerStream(name, PipeDirection.In, 1,
          PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.WaitForConnectionAsync(cancellation.Token).ConfigureAwait(false);
        using var reader = new StreamReader(pipe);
        using var requestTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token);
        requestTimeout.CancelAfter(TimeSpan.FromSeconds(5));
        var message = await reader.ReadLineAsync(requestTimeout.Token).ConfigureAwait(false);
        if (message is not null)
        {
          var options = JsonSerializer.Deserialize<LaunchOptions>(message);
          if (options is not null)
          {
            var validated = LaunchOptions.Parse(["--url", options.Url, "--monitor-index", options.MonitorIndex.ToString()]);
            onLaunch(validated);
          }
        }
      }
      catch (OperationCanceledException) { }
      catch (IOException) { }
      catch (JsonException) { }
      catch (ArgumentException) { }
      // A launch can race the form destroying its handle during shutdown.
      catch (InvalidOperationException) { }
    }
  }

  public void Dispose()
  {
    cancellation.Cancel();
    // Do not block the UI thread waiting on an incoming launch during shutdown.
    if (listener is not null)
      _ = listener.ContinueWith(_ => cancellation.Dispose(), TaskScheduler.Default);
    else
      cancellation.Dispose();
  }
}

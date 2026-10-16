using System.Security.Cryptography;
using System.Text;

namespace ControlPanel.Hud;

internal static class Program
{
  [STAThread]
  private static int Main(string[] args)
  {
    ApplicationConfiguration.Initialize();

    try
    {
      var options = LaunchOptions.Parse(args);
      // Separate checkouts can run independently; restarts of this installation reuse its window.
      var identity = Convert.ToHexString(SHA256.HashData(
        Encoding.UTF8.GetBytes(AppContext.BaseDirectory.ToUpperInvariant())))[..24];
      var instanceName = $"ControlPanel.Hud.{identity}";
      using var mutex = new Mutex(true, $"Local\\{instanceName}", out var isFirstInstance);

      if (!isFirstInstance)
      {
        SingleInstance.Send(instanceName, options);
        return 0;
      }

      try
      {
        using var instance = new SingleInstance(instanceName);
        using var window = new HudForm(options);
        window.Shown += (_, _) => instance.Start(request =>
        {
          if (!window.IsDisposed)
            window.BeginInvoke(() => window.ApplyLaunch(request));
        });
        Application.Run(window);
      }
      finally
      {
        mutex.ReleaseMutex();
      }

      return 0;
    }
    catch (Exception error)
    {
      MessageBox.Show(error.Message, "Control Panel HUD", MessageBoxButtons.OK, MessageBoxIcon.Error);
      return 1;
    }
  }
}

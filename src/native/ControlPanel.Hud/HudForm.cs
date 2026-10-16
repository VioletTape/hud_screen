using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ControlPanel.Hud;

internal sealed class HudForm : Form
{
  private const double HudZoomFactor = 1.33;
  private readonly WebView2 browser = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Black };
  private readonly System.Windows.Forms.Timer retryTimer = new() { Interval = 2000 };
  private readonly NotifyIcon trayIcon = new();
  private readonly ContextMenuStrip trayMenu = new();
  private readonly Icon? appIcon;
  private LaunchOptions options;

  public HudForm(LaunchOptions options)
  {
    this.options = options;
    Text = "Control Panel HUD";
    ShowInTaskbar = false;
    BackColor = Color.Black;
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.Manual;
    AutoScaleMode = AutoScaleMode.Dpi;
    Controls.Add(browser);
    PlaceOnMonitor();

    try
    {
      appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    }
    catch
    {
      // Fall back to SystemIcons.Application if extraction fails
    }

    if (appIcon != null)
      Icon = appIcon;

    trayMenu.Items.Add("Show HUD", null, (_, _) => ShowHud());
    trayMenu.Items.Add("Exit HUD", null, (_, _) => Close());
    trayIcon.Text = Text;
    trayIcon.Icon = appIcon ?? SystemIcons.Application;
    trayIcon.ContextMenuStrip = trayMenu;
    trayIcon.DoubleClick += (_, _) => ShowHud();
    trayIcon.Visible = true;

    Shown += async (_, _) =>
    {
      // Initial WinForms scaling can adjust constructor bounds on mixed-DPI displays.
      PlaceOnMonitor();
      await InitializeBrowserAsync();
    };
    retryTimer.Tick += (_, _) => Navigate();
  }

  protected override bool ShowWithoutActivation => true;

  protected override void Dispose(bool disposing)
  {
    if (disposing)
    {
      trayIcon.Visible = false;
      trayIcon.Dispose();
      appIcon?.Dispose();
      trayMenu.Dispose();
      retryTimer.Dispose();
    }
    base.Dispose(disposing);
  }

  private void ShowHud()
  {
    Show();
    ApplyLaunch(options);
    Activate();
  }

  public void ApplyLaunch(LaunchOptions request)
  {
    options = request;
    WindowState = FormWindowState.Normal;
    PlaceOnMonitor();
    Navigate();
  }

  private void PlaceOnMonitor()
  {
    var screens = Screen.AllScreens;
    var screen = options.MonitorIndex < screens.Length
      ? screens[options.MonitorIndex]
      : Screen.PrimaryScreen ?? screens[0];
    Bounds = screen.Bounds;
  }

  private async Task InitializeBrowserAsync()
  {
    try
    {
      var dataFolder = Path.Combine(AppContext.BaseDirectory, "ControlPanel.Hud.exe.WebView2");
      var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: dataFolder);
      if (IsDisposed)
        return;

      await browser.EnsureCoreWebView2Async(environment);
      browser.CoreWebView2.Settings.IsZoomControlEnabled = false;
      browser.CoreWebView2.Settings.IsPinchZoomEnabled = false;
      browser.ZoomFactor = HudZoomFactor;
      browser.ZoomFactorChanged += (_, _) =>
      {
        if (browser.ZoomFactor != HudZoomFactor)
          browser.ZoomFactor = HudZoomFactor;
      };
      browser.CoreWebView2.NavigationCompleted += (_, navigation) =>
      {
        // Retry failed page loads, including a backend restart during initial navigation.
        if (navigation.IsSuccess)
          retryTimer.Stop();
        else if (navigation.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
          retryTimer.Start();
      };
      Navigate();
    }
    catch (Exception error)
    {
      if (!IsDisposed)
      {
        MessageBox.Show(this,
          $"Could not initialize WebView2. Ensure the Microsoft Edge WebView2 Runtime is installed and this application folder is writable.\n\n{error.Message}",
          Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
      }
    }
  }

  private void Navigate()
  {
    if (browser.CoreWebView2 is null)
      return;

    retryTimer.Stop();
    browser.CoreWebView2.Navigate(options.Url);
  }
}

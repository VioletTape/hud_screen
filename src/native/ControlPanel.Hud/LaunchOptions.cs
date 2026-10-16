namespace ControlPanel.Hud;

internal sealed record LaunchOptions(string Url, int MonitorIndex)
{
  public static LaunchOptions Parse(string[] args)
  {
    var url = "http://localhost:3888/";
    var monitorIndex = 2;

    for (var index = 0; index < args.Length; index++)
    {
      if (index + 1 >= args.Length)
        throw new ArgumentException($"Missing value for {args[index]}.");

      switch (args[index])
      {
        case "--url":
          url = args[++index];
          break;
        case "--monitor-index":
          if (!int.TryParse(args[++index], out monitorIndex) || monitorIndex < 0)
            throw new ArgumentException("Monitor index must be a nonnegative integer (the third screen is 2).");
          break;
        default:
          throw new ArgumentException($"Unknown argument: {args[index]}.");
      }
    }

    if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
        (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
      throw new ArgumentException("HUD URL must be an absolute HTTP or HTTPS URL.");

    return new LaunchOptions(uri.AbsoluteUri, monitorIndex);
  }
}

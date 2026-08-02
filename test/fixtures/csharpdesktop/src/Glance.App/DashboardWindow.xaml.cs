namespace Glance.App;

/// <summary>
/// The dashboard flyout, shown when the tray icon is clicked.
/// <para>Reached from <see cref="App"/> and from the widget board.</para>
/// </summary>
public sealed partial class DashboardWindow
{
    /// <summary>
    /// Rebuilds the chart from <c>usage_intervals</c> and swaps it in.
    /// </summary>
    public void Refresh(int day) => Redraw(day);

    private void Redraw(int day) { }
}

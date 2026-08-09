namespace Glance.App;

/// <summary>The drawing half: everything that turns intervals into pixels.</summary>
public sealed partial class DashboardWindow
{
    private int _lastDay;

    /// <summary>Lays the chart out from the intervals it was last given.</summary>
    public void BuildChart(int day)
    {
        _lastDay = day;
    }
}

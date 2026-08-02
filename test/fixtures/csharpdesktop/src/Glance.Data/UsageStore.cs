using Microsoft.Data.Sqlite;

namespace Glance.Data;

/// <summary>Every reading the tracker has taken, on disk.</summary>
public sealed class UsageStore
{
    /// <summary>Today's totals, by category.</summary>
    public async Task TodayAsync(SqliteConnection connection)
    {
        var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT category_id, seconds FROM usage_intervals WHERE day = $day";
        await cmd.ExecuteReaderAsync();
    }
}

using Microsoft.Data.Sqlite;

namespace Shop.Api.Store;

/// <summary>
/// Raw ADO.NET through a four-line helper somebody wrote — the most ordinary shape in
/// .NET after Entity Framework, and the one no method-name table can see.
/// </summary>
public class PunchStore
{
    private readonly SqliteConnection _connection;

    public PunchStore(SqliteConnection connection) => _connection = connection;

    /// <summary>The SQL is assigned, not passed. Nothing reaches the call itself.</summary>
    public async Task<int> CountAsync()
    {
        var cmd = _connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM punches WHERE status = 'open'";
        return Convert.ToInt32(await cmd.ExecuteScalarAsync());
    }

    /// <summary>
    /// A statement that explains itself. The comment says "come from the shop's
    /// database", and `from` is looked for before `into` — so this upsert used to
    /// report a table called `the`.
    /// </summary>
    public async Task UpsertAsync(SqliteConnection connection)
    {
        await using var cmd = connection.Sql("""
            INSERT INTO employees (user_id, full_name, is_active)
            VALUES ($id, $full, 1)
            ON CONFLICT(user_id) DO UPDATE SET
                -- Kept rather than cleared when absent: these come from the
                -- shop's own database, which is not always reachable.
                full_name = excluded.full_name;
            """);
        await cmd.ExecuteNonQueryAsync();
    }

    /// <summary>An interpolated column list, and a table written down all the same.</summary>
    public async Task ByJobAsync(SqliteConnection connection, string columns)
    {
        await using var cmd = connection.Sql($"SELECT {columns} FROM job_stations WHERE job_number = $job");
        await cmd.ExecuteReaderAsync();
    }

    /// <summary>Prose that opens with a SQL keyword. Not a query, and not a table.</summary>
    public string Explain() => "Update the settings for this shop before syncing again.";
}

public static class Db
{
    /// <summary>The helper. Its name is this repo's business, not App Atlas's.</summary>
    public static SqliteCommand Sql(this SqliteConnection connection, string sql)
    {
        var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        return cmd;
    }
}

using Dapper;
using Npgsql;

namespace Shop.Api.Services;

/// <summary>Talks to the pricing service, and reads the ledger directly.</summary>
public class PricingClient
{
    private const string FeedUrl = "https://rates.example-vendor.com/v2/latest";
    private readonly HttpClient _http;

    public PricingClient(HttpClient http) => _http = http;

    public async Task<string> LatestAsync()
    {
        var response = await _http.GetAsync(FeedUrl);
        return await response.Content.ReadAsStringAsync();
    }

    public async Task ReportAsync(object payload)
    {
        await _http.PostAsJsonAsync("https://telemetry.example-vendor.com/ingest", payload);
    }

    public async Task<int> LedgerCountAsync(NpgsqlConnection conn)
    {
        return await conn.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM ledger_entries");
    }

    public string ApiKey() => Environment.GetEnvironmentVariable("PRICING_API_KEY") ?? "";
}

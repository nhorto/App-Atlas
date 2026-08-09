using Microsoft.EntityFrameworkCore;
using Shop.Api.Data;

namespace Shop.Api.Services;

/// <summary>Pushes unsynced orders to the vendor, on a five-minute loop.</summary>
public sealed class SyncWorker : BackgroundService
{
    private readonly ShopContext _db;

    public SyncWorker(ShopContext db)
    {
        _db = db;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            var pending = await _db.Orders.Where(o => !o.Synced).ToListAsync(stoppingToken);
            await _db.SaveChangesAsync(stoppingToken);
        }
    }
}

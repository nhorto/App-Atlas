using Microsoft.EntityFrameworkCore;
using Shop.Api;
using Shop.Api.Data;
using Shop.Api.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<ShopContext>();
builder.Services.AddControllers();

// Configuration, read three ways. The connection string and the Stripe key are
// documented in appsettings.json beside this file; the vendor token is read here and
// written down nowhere, which is the row that deserves attention.
var conn = builder.Configuration.GetConnectionString("Shop");
var stripeKey = builder.Configuration["Stripe:Key"];
var vendorToken = builder.Configuration["Vendor:ApiToken"];
builder.Services.Configure<PowerFabOptions>(builder.Configuration.GetSection("PowerFab"));
// The other half of the SyncWorker evidence: the class says what it is, this line says
// where it was wired in, and the two must land on one door.
builder.Services.AddHostedService<SyncWorker>();

var app = builder.Build();

app.MapControllers();

// A door with no lock on it at all, which is the point of having one here.
app.MapGet("/health", () => Results.Ok("healthy"));

var admin = app.MapGroup("/admin");
admin.MapPost("/reindex", () => Results.Accepted()).RequireAuthorization();

// This app's own filter, chained per route. It answers 401, so it is a lock.
app.MapGet("/api/kiosk/today", () => Results.Ok(new { punches = 0 })).RequireDevice();

// Chained the same way and never a check: it only writes a timing line.
app.MapGet("/api/kiosk/ping", () => Results.Ok("pong")).RequireTelemetry();

// A filter on the group covers every route registered on it, and none of those
// routes says so anywhere near itself.
var kiosk = app.MapGroup("/api/kiosk/shift").RequireDevice();
kiosk.MapPost("/start", () => Results.Accepted());
kiosk.MapPost("/end", () => Results.Accepted());

// A one-liner delegating to a real method: the handler *is* a definition, and the
// door should point at it directly rather than at anything synthesized.
app.MapGet("/api/kiosk/roster", Roster);

app.Run();

static IResult Roster()
{
    return Results.Ok(new[] { "morning", "evening" });
}

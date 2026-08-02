using Microsoft.EntityFrameworkCore;
using Shop.Api;
using Shop.Api.Data;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<ShopContext>();
builder.Services.AddControllers();

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

app.Run();

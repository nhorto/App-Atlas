using Microsoft.EntityFrameworkCore;
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

app.Run();

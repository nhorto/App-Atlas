using Microsoft.AspNetCore.Http;

namespace Shop.Api;

/// <summary>
/// This app's own auth, which is neither `[Authorize]` nor `.RequireAuthorization()`.
///
/// A great many real .NET services look exactly like this: an endpoint filter written
/// in-house, chained onto the routes it covers, answering 401 from inside. What makes
/// it a check is the status it writes — not the word "Require" in its name.
/// </summary>
public static class AuthFilters
{
    public static IEndpointConventionBuilder RequireDevice(this IEndpointConventionBuilder builder) =>
        builder.AddEndpointFilter(async (context, next) =>
            context.HttpContext.Items.ContainsKey("device")
                ? await next(context)
                : Results.Json(new { error = "paired device required" },
                    statusCode: StatusCodes.Status401Unauthorized));

    /// <summary>Chained onto routes exactly like the one above, and never a check.</summary>
    public static IEndpointConventionBuilder RequireTelemetry(this IEndpointConventionBuilder builder) =>
        builder.AddEndpointFilter(async (context, next) =>
        {
            Console.WriteLine("timing");
            return await next(context);
        });
}

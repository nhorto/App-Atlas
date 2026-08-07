using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc;

namespace Shop.Api.Controllers;

/// <summary>Where sessions are handed out — and the one door that must stay flagged.</summary>
[ApiController]
[Route("api/auth")]
public class AuthController : ControllerBase
{
    // The door people sign in through cannot require a session. The evidence is the
    // call that issues one, not the word "auth" in the address.
    [HttpPost("login")]
    public async Task<IActionResult> Login(string user)
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.Name, user) }, "Cookies"));
        await HttpContext.SignInAsync("Cookies", principal);
        return Ok();
    }

    [HttpPost("logout")]
    public async Task<IActionResult> Logout()
    {
        await HttpContext.SignOutAsync();
        return Ok();
    }

    // A genuine first-run hole, deliberately: nothing here hands out a session, so no
    // rule may excuse it — least of all its address.
    [HttpPost("setup")]
    public IActionResult Setup(string adminName)
    {
        return Ok(adminName);
    }
}

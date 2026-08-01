using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Shop.Api.Data;

namespace Shop.Api.Controllers;

/// <summary>Everything a signed-in customer can do with their own orders.</summary>
[ApiController]
[Route("api/v1/[controller]")]
[Authorize]
public class OrdersController : ControllerBase
{
    private readonly ShopContext _db;

    public OrdersController(ShopContext db) => _db = db;

    /// <summary>One order, by id.</summary>
    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetOrder(int id)
    {
        var order = await _db.Orders.FirstOrDefaultAsync(o => o.Id == id);
        return Ok(order);
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] OrderRequest request)
    {
        _db.Orders.Add(new Order { Sku = request.Sku });
        await _db.SaveChangesAsync();
        return Created();
    }

    /// <summary>The one action on this controller a stranger may reach.</summary>
    [HttpGet("public-status")]
    [AllowAnonymous]
    public IActionResult Status() => Ok("up");
}

public record OrderRequest(string Sku, int Quantity);

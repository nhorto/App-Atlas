using Microsoft.EntityFrameworkCore;

namespace Shop.Api.Data;

/// <summary>Every table this app knows about, declared in one place.</summary>
public class ShopContext : DbContext
{
    public DbSet<Order> Orders { get; set; }
    public DbSet<Customer> Customers { get; set; }

    private string _connectionString = "";
}

public class Order
{
    public int Id { get; set; }
    public string Sku { get; set; } = "";
    internal string InternalNote { get; set; } = "";
}

public class Customer
{
    public int Id { get; set; }
    public string Email { get; set; } = "";
}

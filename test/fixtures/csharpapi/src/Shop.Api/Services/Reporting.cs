using System.Linq;

namespace Shop.Api.Services;

/// <summary>Plain LINQ over plain lists. None of this is a database.</summary>
public class Reporting
{
    private readonly List<string> _skus = new();

    public IEnumerable<string> Active() => _skus.Where(s => s.Length > 0).Select(s => s.ToUpper());

    public int Total() => _skus.Count();

    public void Track(string sku) => _skus.Add(sku);
}

/// <summary>
/// Named like a controller and is not one: no [ApiController], no [Route], no verbs.
/// A door invented from a naming convention is a door nobody can knock on.
/// </summary>
public class PaymentController
{
    public string Get() => "not a route";
    public string Post() => "also not a route";
}

namespace Fabis.Tool;

/// <summary>A console tool. No markup, no screens, nothing answering a URL.</summary>
public static class Program
{
    /// <summary>Reads a job number and prints its stations.</summary>
    public static void Main(string[] args) => Console.WriteLine(args.Length);
}

/// <summary>Exported, and not a public API — nobody imports a console app.</summary>
public sealed class StationReport
{
    public int JobNumber { get; set; }
}

namespace Glance.Core.Entities;

/// <summary>A tracked program: the thing usage intervals are recorded against.</summary>
public class App
{
    public string Name { get; set; } = "";
    public string ExecutablePath { get; set; } = "";
}

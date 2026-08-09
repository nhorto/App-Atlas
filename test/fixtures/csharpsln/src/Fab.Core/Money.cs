namespace Fab.Core;

/// <summary>An amount in cents, so nothing downstream ever rounds.</summary>
public record Money(long Cents);

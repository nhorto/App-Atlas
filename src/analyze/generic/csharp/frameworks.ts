/**
 * @fileoverview Which .NET package means which framework, and where .NET writes them down.
 *
 * One table, read by two things that must never disagree: the label the app carries at
 * the top of the map, and the gate on the detectors. A repo whose header says "ASP.NET
 * Core" and whose boundary view is empty is a repo where these two tables drifted apart.
 *
 * .NET is unusual in this codebase in that its most important framework is not a package
 * at all. ASP.NET Core ships *inside* the runtime, reached through
 * `<Project Sdk="Microsoft.NET.Sdk.Web">` and a `FrameworkReference`, so a web service's
 * project file can list no web dependency whatsoever. The SDK attribute is the
 * declaration, and it is read here beside the packages.
 */

/** Package id prefix → the label a reader would recognise. */
export const DOTNET_FRAMEWORKS: Record<string, string> = {
  'Microsoft.AspNetCore': 'ASP.NET Core',
  'Microsoft.EntityFrameworkCore': 'Entity Framework Core',
  'Microsoft.Extensions.Hosting': '.NET Generic Host',
  Dapper: 'Dapper',
  Serilog: 'Serilog',
  MediatR: 'MediatR',
  Hangfire: 'Hangfire',
  Quartz: 'Quartz.NET',
  MassTransit: 'MassTransit',
  Swashbuckle: 'Swagger',
  FluentValidation: 'FluentValidation',
  AutoMapper: 'AutoMapper',
  Npgsql: 'Npgsql',
  'MongoDB.Driver': 'MongoDB',
  StackExchange: 'Redis',
  'Azure.Storage': 'Azure Storage',
  'AWSSDK.S3': 'Amazon S3',
  Stripe: 'Stripe',
  xunit: 'xUnit',
  NUnit: 'NUnit',
  MSTest: 'MSTest',
};

/**
 * SDK attribute → label. `Microsoft.NET.Sdk.Web` is how a project says it is a web
 * application, and on a service that references nothing it is the only thing that does.
 */
export const DOTNET_SDKS: Record<string, string> = {
  'Microsoft.NET.Sdk.Web': 'ASP.NET Core',
  'Microsoft.NET.Sdk.Worker': '.NET Worker Service',
  'Microsoft.NET.Sdk.BlazorWebAssembly': 'Blazor WebAssembly',
};

/**
 * The label for a package id, or null when nothing in the table claims it.
 *
 * Matched as a prefix because .NET package ids are dotted namespaces and the pieces that
 * matter are at the front: `Microsoft.AspNetCore.Authentication.JwtBearer` is ASP.NET
 * Core, and a table listing every one of that family's forty packages would be a table
 * that is always one release out of date.
 */
export function dotnetFrameworkFor(id: string): string | null {
  for (const [prefix, label] of Object.entries(DOTNET_FRAMEWORKS)) {
    if (id === prefix || id.startsWith(`${prefix}.`)) return label;
  }
  return null;
}

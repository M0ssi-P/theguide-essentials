using System.Text.Json;
using Lucene.Net.Documents;
using Lucene.Net.Index;
using Lucene.Net.Search;
using Lucene.Net.Store;
using Lucene.Net.Util;

if (args.Length < 2)
{
    Console.Error.WriteLine("Usage: LuceneDump <indexDir> <outputJsonPath> [productId]");
    return 1;
}

string indexDir = args[0];
string outputPath = args[1];
string? productId = args.Length >= 3 ? args[2] : null;

if (!System.IO.Directory.Exists(indexDir))
{
    Console.Error.WriteLine($"Index directory not found: {indexDir}");
    return 1;
}

var docs = new List<Dictionary<string, object>>();

using (var directory = FSDirectory.Open(indexDir))
using (var reader = DirectoryReader.Open(directory))
{
    IBits? liveDocs = MultiFields.GetLiveDocs(reader);

    IEnumerable<int> docIds;
    if (productId != null)
    {
        var searcher = new IndexSearcher(reader);
        var query = new TermQuery(new Term("productId", productId));
        TopDocs hits = searcher.Search(query, reader.MaxDoc);
        docIds = hits.ScoreDocs.Select(sd => sd.Doc);
        Console.Error.WriteLine($"Query for productId=\"{productId}\" matched {hits.TotalHits} document(s).");
    }
    else
    {
        docIds = Enumerable.Range(0, reader.MaxDoc);
    }

    foreach (int docId in docIds)
    {
        if (liveDocs != null && !liveDocs.Get(docId))
            continue;

        Document doc = reader.Document(docId);
        var fieldMap = new Dictionary<string, object>();

        foreach (var group in doc.Fields.GroupBy(f => f.Name))
        {
            string[] values = group.Select(f => f.GetStringValue() ?? string.Empty).ToArray();
            fieldMap[group.Key] = values.Length == 1 ? values[0] : values;
        }

        docs.Add(fieldMap);
    }
}

string json = JsonSerializer.Serialize(docs, new JsonSerializerOptions { WriteIndented = true });

if (outputPath == "-")
{
    Console.Out.Write(json);
    Console.Error.WriteLine($"Wrote {docs.Count} documents to stdout");
}
else
{
    File.WriteAllText(outputPath, json);
    Console.Error.WriteLine($"Wrote {docs.Count} documents to {outputPath}");
}
return 0;

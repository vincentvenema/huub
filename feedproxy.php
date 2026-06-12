<?php
// Minimal allowlisted feed proxy.
// Fetches a Substack RSS feed from this host's IP (which Substack serves, unlike
// the GitHub Actions runner) and returns it verbatim. Allowlisted, not an open proxy.

$u = isset($_GET['u']) ? $_GET['u'] : '';
$allow = array('firstfloor.substack.com', 'futurismrestated.substack.com');

$host = $u ? parse_url($u, PHP_URL_HOST) : '';
if (!$host || !in_array($host, $allow, true)) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'forbidden';
    exit;
}

$ch = curl_init($u);
curl_setopt_array($ch, array(
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_TIMEOUT => 25,
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    CURLOPT_HTTPHEADER => array('Accept: application/rss+xml, application/xml, text/xml, */*'),
));
$body = curl_exec($ch);
$code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($body === false || $code >= 400) {
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'upstream error ' . $code;
    exit;
}

header('Content-Type: application/rss+xml; charset=utf-8');
header('Cache-Control: max-age=300');
echo $body;

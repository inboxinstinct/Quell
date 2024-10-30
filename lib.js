const { exec } = require('child_process');
const simpleParser = require('mailparser').simpleParser;
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function hexToFileName(hex) {
    // Convert hex to ASCII
    let fileName = '';
    for (let i = 0; i < hex.length; i += 2) {
        fileName += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    // Remove any non-printable characters
    fileName = fileName.replace(/[^\x20-\x7E]/g, '');
    // Trim the first part of the filename (e.g., "image_")
    fileName = fileName.replace(/^[^_]*_/, '');
    // If the result is empty or invalid, return a default name
    return fileName.length > 0 ? fileName : 'image';
}

function extractLinks(content) {
    const linkRegex = /(?:<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>|href=["']([^"']+)["']|http[s]?:\/\/(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\\(\\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+)/g;
    const matches = [...content.matchAll(linkRegex)];
    const links = [];

    matches.forEach(match => {
        const link = match[1] || match[3] || match[0];
        const linkContent = match[2] ? match[2].trim() : '';
        let context = linkContent.replace(/<[^>]+>/g, '') || 'No text';

        // Filter out image placeholder URLs
        if (link.includes('camo.missiveusercontent.com') || link.includes('image.gif')) {
            return;
        }

        if (linkContent.startsWith('<img')) {
            const imgSrc = linkContent.match(/src=["']([^"']*)/i)?.[1];
            if (imgSrc) {
                const decodedImgSrc = decodeURIComponent(imgSrc);
                let fileName = decodedImgSrc.split('/').pop(); // Extract filename
                const fileNameWithoutExt = fileName.split('.')[0];
                
                // Check if the filename is a hexadecimal string
                if (/^[0-9a-fA-F]+$/.test(fileNameWithoutExt)) {
                    const realFileName = hexToFileName(fileNameWithoutExt);
                    context = realFileName + path.extname(fileName);
                } else {
                    context = fileName;
                }
            } else {
                context = 'Image';
            }
        }

        const existingLink = links.find(l => l.link === link);
        if (existingLink) {
            if (!existingLink.contexts.includes(context)) {
                existingLink.contexts.push(context);
            }
        } else {
            links.push({ link, contexts: [context] });
        }
    });

    return links.filter(({ link }) => !link.startsWith('mailto:') && !/\.(jpg|jpeg|png|gif|bmp|svg)$/i.test(link));
}

async function handleUpload(req, res) {
    try {
        if (req.body.emailContent) {
            // webhook data
            const content = JSON.parse(req.body.emailContent);
            const links = extractLinks(content.messages.body);
            const processedLinks = await processLinks(links);
            res.json(processedLinks);
        } else if (req.file) {
            // .eml file upload
            const emlContent = await fs.readFile(req.file.path, 'utf8');
            const parsed = await simpleParser(emlContent);
            const links = extractLinks(parsed.html || parsed.textAsHtml || parsed.text);
            const processedLinks = await processLinks(links);
            
            await fs.unlink(req.file.path);
            
            res.json(processedLinks);
        } else {
            throw new Error('No valid input provided');
        }
    } catch (error) {
        console.error('Error processing upload:', error);
        res.status(500).json({ error: error.message });
    }
}

async function processLinks(links) {
    const processedLinks = {};
    for (const { link, contexts } of links) {
        console.log('Processing link:', link);
        const unwrappedLink = await unwrapLink(link);
        
        if (processedLinks[unwrappedLink]) {
            processedLinks[unwrappedLink].contexts.push(...contexts.filter(c => !processedLinks[unwrappedLink].contexts.includes(c)));
            if (!processedLinks[unwrappedLink].wrapperHistory.includes(link)) {
                processedLinks[unwrappedLink].wrapperHistory.push(link);
            }
        } else {
            processedLinks[unwrappedLink] = { 
                originalLink: unwrappedLink,
                contexts: contexts,
                wrapperHistory: [link]
            };
        }
    }
    
    // Calculate count based on number of contexts
    for (const info of Object.values(processedLinks)) {
        info.count = info.contexts.length;
    }
    
    return processedLinks;
}

const execPromise = util.promisify(exec);

async function unwrapLink(link) {
    try {
        // Remove any trailing backslashes
        const cleanedLink = link.replace(/\\+$/, '');
        
        // Attempt to decode the URL, but fall back to the original if it fails
        let decodedLink;
        try {
            decodedLink = decodeURIComponent(cleanedLink);
        } catch (e) {
            decodedLink = cleanedLink;
        }
        
        // Use a custom User-Agent to mimic a browser
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
        
        // Use curl with additional options for better URL handling
        const { stdout } = await execPromise(`curl -Ls -A "${userAgent}" -o /dev/null -w %{url_effective} "${decodedLink}"`);
        
        return stdout.trim();
    } catch (error) {
        console.log(`Unable to unwrap link: ${link}. Error: ${error.message}`);
        return link;
    }
}




module.exports = {
    extractLinks,
    handleUpload,
    processLinks,
    unwrapLink
};

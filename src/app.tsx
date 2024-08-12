import React, { useState } from "react";
import { Button, Text, ProgressBar, Box, Grid, TextInput } from "@canva/app-ui-kit";
import { useSelection } from "utils/use_selection_hook";
import styles from "styles/components.css";
import { addPage, getDefaultPageDimensions } from "@canva/design"
import { zodResponseFormat } from 'openai/helpers/zod';
import OpenAI from 'openai';
import { z } from 'zod';
import { addNativeElement, createRichtextRange } from "@canva/preview/design";
import { upload } from "@canva/asset";

const defaultPageDims = await getDefaultPageDimensions();

const headerElementWidth = defaultPageDims.width * 0.7
const embedElementWidth = defaultPageDims.width * 0.5;


export function App() {
  const [progressBarVal, setProgressBarVal] = useState(0);
  const currentSelection = useSelection("plaintext");
  const isElementSelected = currentSelection.count > 0;
  const [response, setResponse] = useState("");
  const [userInput, setUserInput] = useState("");
  const [speechText, setSpeechText] = useState("");


  const Slide = z.object({
    title: z.string(),
    speech: z.string(),
    bullet_points: z.array(z.string()),
    image: z.array(z.string()),
    notes: z.string(),
    background_color: z.string(),
    duration: z.string()
  });
  const SlidePresentation = z.object({
    slides: z.array(Slide)
  });
  const systemPrompt = "You are an extremely helpful slides presentation assistant. You will generate slides based on the user input in the response format. Please ensure background colors match the topic that user inputs. Refrain from using dark background colors.Have at least 3 background colors for the slides. For the image, we should have images for each bullet point. The image should not be a url but the name of what is inside the image. For the speech, we should have at least 3 lines of content for each slide.  "

  async function generateSlidePresentation(text: string) {
    const apiUrl = 'https://api.openai.com/v1/chat/completions';

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer INSERT_API_KEY' // Replace with your actual API key
        },
        body: JSON.stringify({
          model: "gpt-4o-2024-08-06",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text }
          ],
          response_format: zodResponseFormat(SlidePresentation, 'slide_presentation'),
        })
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorBody}`);
      }

      const data = await response.json();

      if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
        // Parse the content string as JSON
        return JSON.parse(data.choices[0].message.content);
      } else {
        console.error("Unexpected response structure:", JSON.stringify(data, null, 2));
        return "Error: Unexpected response structure";
      }
    } catch (error) {
      console.error("Error calling OpenAI API:", error);
      return `Error occurred while processing the request: ${error.message}`;
    }
  }

  function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  async function parseResponse(result: any) {
    if (result && result.slides && Array.isArray(result.slides)) {
      let speechArray: string[] = []; // Local array to collect speech

      for (let i = 0; i < result.slides.length; i++) {
        await addSlide(result.slides[i], speechArray);

        // Update progress bar 
        const interval = Math.min((100 / result.slides.length) * (i + 1), 100);
        setProgressBarVal(interval);

        // Add a 5-second delay after every slide
        await delay(5000);

        // If we've processed 20 slides, add a longer delay to respect the rate limit
        if ((i + 1) % 20 === 0) {
          console.log("Reached 20 slides, waiting for 10 seconds...");
          await delay(10000);
        }
      }

      // Combine speech here
      if (speechArray.length > 0) {
        setSpeechText(speechArray.join("\n"));
      }

      setProgressBarVal(100); // Set the progress bar to 100 when done
    } else {
      console.error("Invalid result structure");
    }
  }



  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), ms)
      ),
    ]);
  }
  async function retryWithBackoff(fn, retries = 3, delay = 1000) {
    try {
      return await fn();
    } catch (error) {
      if (retries > 0) {
        console.log(`Retrying... Attempts left: ${retries}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return retryWithBackoff(fn, retries - 1, delay * 2); // Exponential backoff
      } else {
        throw error;
      }
    }
  }

  async function addSlide(slide: any,speechArray: string[]) {
    console.log(`Adding slide: ${slide.title}`);
    await addPage({
      title: slide.title,
      background: { color: slide.background_color },
    });
    await addNativeElement({
      type: "TEXT",
      children: [slide.title],
      fontSize: 48,
      fontWeight: "semibold",
      width: headerElementWidth,
      height: "auto",
      top: defaultPageDims.height * 0.1, // shift from top by 10%
      left: defaultPageDims.width / 2 - headerElementWidth / 2,
    });
    // Here you would add more elements to the slide based on the slide object
    // For example:
    // - Add text boxes for bullet points
    // - Add an image (if Canva SDK supports this)
    // - Set animation (if supported)
    // - Add speaker notes (if supported)


    // transform array to bulleted string, need to do this cause of plaintext formatting
    const points = slide.bullet_points.map(item => `• ${item}`).join('\n');
    console.log(`Adding bullet point: ${points}`);

    await addNativeElement({
      type: "TEXT",
      children: [points],
      width: embedElementWidth,
      height: "auto",
      top: defaultPageDims.height * 0.4,
      left: defaultPageDims.width / 2 - embedElementWidth / 2,
    });

    //Adding to speechArray
    speechArray.push(slide.speech);
    console.log(slide.speech);

    console.log(`Image to add: ${slide.image}`);
    const imagesToAdd = slide.image.length;
    const imageWidth = embedElementWidth / 3; // Adjust this value as needed
    const imageHeight = imageWidth; // Assuming square images, adjust if necessary
    const verticalPosition = defaultPageDims.height * 0.6; // Adjust this value to position images below the text

    for (let i = 0; i < imagesToAdd; i++) {
      const imageDescription = slide.image[i];
      try {
        const imageUrls = await withTimeout(getImageUrls(imageDescription), 5000); // 5-second timeout
        console.log(`Found ${imageUrls.length} image URLs for description "${imageDescription}"`);

        let success = false;
        for (let j = 0; j < imageUrls.length; j++) {
          const imageUrl = imageUrls[j];
          console.log(`Attempting to add image ${j + 1}/${imageUrls.length}: ${imageUrl}`);
          try {
            // Ensure these values are defined
            let left = 0, top = verticalPosition; // Set default values

            if (imagesToAdd === 1) {
              // Single image: center bottom
              left = (defaultPageDims.width / 2) - (imageWidth / 2);
            } else if (imagesToAdd === 2) {
              // Two images: balanced left and right
              left = (i === 0) ? (defaultPageDims.width / 4 - imageWidth / 2) : (defaultPageDims.width * 3 / 4 - imageWidth / 2);
            } else if (imagesToAdd === 3) {
              // Three images: bottom left, center, and right
              left = (defaultPageDims.width * (i + 1) / 4) - (imageWidth / 2);
            }

            // Ensure that left, top, width, and height are valid
            if (left !== undefined && top !== undefined && imageWidth !== undefined && imageHeight !== undefined) {
              await retryWithBackoff(() => withTimeout(addNativeElement({
                type: "EMBED",
                url: imageUrl,
                width: imageWidth,
                height: imageHeight,
                top: top,
                left: left,
              }), 5000)); // 5-second timeout with retries

              console.log(`Successfully added image from URL: ${imageUrl}`);
              success = true;
              break; // Exit the loop if the image was added successfully
            } else {
              console.error(`Invalid placement properties: left=${left}, top=${top}, width=${imageWidth}, height=${imageHeight}`);
            }
          } catch (error) {
            console.error(`Failed to add image from URL: ${imageUrl}`, error);
          }
        }

        if (!success) {
          console.log(`Failed to add any image for: ${imageDescription}`);
        }
      } catch (error) {
        console.error(`Error processing image description "${imageDescription}":`, error);
      }
    }
    console.log(`Notes: ${slide.notes}`);
    // Add notes if Canva SDK supports it
  }

  async function getImageUrls(query) {
    const searchEngineId = "INSERT_API_KEY";
    const apiKey = "INSERT_API_KEY";

    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${query}&searchType=image`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.items && data.items.length > 0) {
      const imageUrls = data.items.slice(0, 5).map(item => item.link); // Get the first 3 image results
      console.log('Image URLs:', imageUrls);
      return imageUrls;
    } else {
      return [];
    }
  }

  async function handleClick() {
    if (!userInput.trim()) {
      console.log("No user input provided");
      return;
    }

    console.log("User input:", userInput);
    try {
      const result = await generateSlidePresentation(userInput);
      console.log("Parsed content:");
      console.log(JSON.stringify(result, null, 2));
      setResponse(JSON.stringify(result, null, 2)); // Set the response to state

      // Call parseResponse with the result
      await parseResponse(result);
    } catch (error) {
      console.error("Error:", error);
      setResponse(`Error: ${error.message}`);
    }
  }



  return (
    <div className={styles.scrollContainer}>
      <Box padding="1u">
        <TextInput
          value={userInput}
          onChange={(value) => setUserInput(value)}
          placeholder="Enter your topic here"
        />
      </Box>
      <Box padding="1u">

        <Button
          variant="primary"
          onClick={handleClick}
        >
          Process selected text with OpenAI
        </Button>
      </Box>
      <Box padding="1u">
        <ProgressBar
          style={{ marginTop: '100px' }}
          size="medium"
          tone="info"
          value={progressBarVal}
        />
      </Box>
      <Box
        background="neutralLow"
        borderRadius="large"
        padding="2u"
      >
        <Text>
          <strong>Speech:</strong>
          <br />
          {speechText}
        </Text>
      </Box>
    </div>

  );
}
